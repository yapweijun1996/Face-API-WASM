/**
 * tms-tabular.js
 * --------------
 * Small offline table helper for TMS pages: filter, sort, paginate, render.
 */

const TmsTabular = (() => {
    'use strict';

    class Table {
        constructor(options) {
            this.tbody = options.tbody;
            this.empty = options.empty || null;
            this.filterInput = options.filterInput || null;
            this.pageSizeSelect = options.pageSizeSelect || null;
            this.prevBtn = options.prevBtn || null;
            this.nextBtn = options.nextBtn || null;
            this.pageInfo = options.pageInfo || null;
            this.sortButtons = [...(options.sortButtons || [])];
            this.columns = options.columns || [];
            this.pageInfoText = options.pageInfoText || ((s) => `${s.start}-${s.end} / ${s.total}`);
            this.data = [];
            this.page = 1;
            this.pageSize = this.pageSizeSelect ? parseInt(this.pageSizeSelect.value, 10) || 10 : 10;
            this.filter = '';
            this.sortKey = options.sortKey || '';
            this.sortDir = options.sortDir || 'desc';
            this.bind();
        }

        bind() {
            if (this.filterInput) {
                this.filterInput.addEventListener('input', () => {
                    this.filter = this.filterInput.value.trim().toLowerCase();
                    this.page = 1;
                    this.render();
                });
            }
            if (this.pageSizeSelect) {
                this.pageSizeSelect.addEventListener('change', () => {
                    this.pageSize = parseInt(this.pageSizeSelect.value, 10) || 10;
                    this.page = 1;
                    this.render();
                });
            }
            if (this.prevBtn) this.prevBtn.addEventListener('click', () => { this.page--; this.render(); });
            if (this.nextBtn) this.nextBtn.addEventListener('click', () => { this.page++; this.render(); });
            this.sortButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    const key = btn.dataset.recordSort;
                    if (!key) return;
                    if (this.sortKey === key) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
                    else { this.sortKey = key; this.sortDir = 'asc'; }
                    this.page = 1;
                    this.render();
                });
            });
        }

        setData(rows) {
            this.data = Array.isArray(rows) ? rows.slice() : [];
            this.page = 1;
            this.render();
        }

        refreshLabels() {
            this.render();
        }

        column(key) {
            return this.columns.find(col => col.key === key);
        }

        rawValue(row, col) {
            if (!col) return '';
            if (typeof col.value === 'function') return col.value(row);
            return row[col.key];
        }

        filterValue(row, col) {
            if (typeof col.filterValue === 'function') return col.filterValue(row);
            return this.rawValue(row, col);
        }

        sortValue(row, col) {
            if (typeof col.sortValue === 'function') return col.sortValue(row);
            return this.rawValue(row, col);
        }

        filteredRows() {
            if (!this.filter) return this.data.slice();
            return this.data.filter(row => this.columns.some(col => {
                const value = this.filterValue(row, col);
                return String(value == null ? '' : value).toLowerCase().includes(this.filter);
            }));
        }

        processedRows() {
            const rows = this.filteredRows();
            const col = this.column(this.sortKey);
            if (!col) return rows;
            const dir = this.sortDir === 'asc' ? 1 : -1;
            return rows.sort((a, b) => compareValues(this.sortValue(a, col), this.sortValue(b, col)) * dir);
        }

        exportRows() {
            return this.processedRows();
        }

        render() {
            const rows = this.processedRows();
            const total = rows.length;
            const maxPage = Math.max(1, Math.ceil(total / this.pageSize));
            this.page = Math.min(Math.max(1, this.page), maxPage);
            const startIndex = total ? (this.page - 1) * this.pageSize : 0;
            const pageRows = rows.slice(startIndex, startIndex + this.pageSize);

            this.tbody.innerHTML = '';
            pageRows.forEach(row => this.renderRow(row));

            if (this.empty) this.empty.style.display = total ? 'none' : 'block';
            if (this.prevBtn) this.prevBtn.disabled = this.page <= 1;
            if (this.nextBtn) this.nextBtn.disabled = this.page >= maxPage;
            if (this.pageInfo) {
                const start = total ? startIndex + 1 : 0;
                const end = total ? startIndex + pageRows.length : 0;
                this.pageInfo.textContent = this.pageInfoText({ start, end, total, page: this.page, pages: maxPage });
            }
            this.sortButtons.forEach(btn => {
                btn.classList.toggle('asc', btn.dataset.recordSort === this.sortKey && this.sortDir === 'asc');
                btn.classList.toggle('desc', btn.dataset.recordSort === this.sortKey && this.sortDir === 'desc');
            });
        }

        renderRow(row) {
            const tr = document.createElement('tr');
            this.columns.forEach(col => {
                const td = document.createElement('td');
                if (typeof col.render === 'function') col.render(row, td);
                else td.textContent = String(this.rawValue(row, col) ?? '');
                tr.appendChild(td);
            });
            this.tbody.appendChild(tr);
        }
    }

    function compareValues(a, b) {
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        if (a == null && b == null) return 0;
        if (a == null) return -1;
        if (b == null) return 1;
        return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
    }

    return { Table };
})();
