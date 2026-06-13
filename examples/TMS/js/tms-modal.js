/**
 * tms-modal.js
 * ------------
 * Single source of truth for standard TMS modal dialogs.
 */

const TmsModal = (() => {
    'use strict';

    let root = null;
    let i18n = null;
    let iconFn = null;
    let active = null;
    let lastFocus = null;

    const focusableSelector = [
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        'a[href]',
        '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    function t(key, vars) {
        return i18n && typeof i18n.t === 'function' ? i18n.t(key, vars) : key;
    }

    function ico(name) {
        return iconFn ? iconFn(name) : '';
    }

    function init(options = {}) {
        root = options.root || document.getElementById('appModal');
        i18n = options.i18n || window.I18N || null;
        iconFn = options.icon || null;
        if (!root) throw new Error('TmsModal root not found');
        root.addEventListener('click', (e) => {
            if (e.target === root && active && active.backdropClose !== false) close(null);
        });
        document.addEventListener('keydown', (e) => {
            if (!active) return;
            if (e.key === 'Escape' && active.escapeClose !== false) {
                e.preventDefault();
                close(null);
            } else if (e.key === 'Tab') {
                trapFocus(e);
            }
        });
    }

    function trapFocus(e) {
        const nodes = [...root.querySelectorAll(focusableSelector)];
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }

    function asNode(content) {
        if (content instanceof Node) return content;
        const div = document.createElement('div');
        div.textContent = String(content || '');
        return div;
    }

    function open(options = {}) {
        if (!root) init();
        if (active) close(null, { restoreFocus: false });
        lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        return new Promise((resolve) => {
            active = { resolve, backdropClose: options.backdropClose, escapeClose: options.escapeClose };
            root.innerHTML = '';
            root.setAttribute('aria-hidden', 'false');
            root.classList.add('show');

            const card = document.createElement('div');
            card.className = 'modal-card standard' + (options.wide ? ' wide' : '');
            card.setAttribute('role', 'dialog');
            card.setAttribute('aria-modal', 'true');
            card.setAttribute('aria-labelledby', 'appModalTitle');

            const head = document.createElement('div');
            head.className = 'modal-head';
            const title = document.createElement('h3');
            title.id = 'appModalTitle';
            title.textContent = options.title || '';
            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'modal-close';
            closeBtn.setAttribute('aria-label', t('close'));
            closeBtn.innerHTML = ico('x-circle');
            closeBtn.addEventListener('click', () => close(null));
            head.append(title, closeBtn);

            const body = document.createElement('div');
            body.className = 'modal-body';
            body.appendChild(asNode(options.body));

            const actions = document.createElement('div');
            actions.className = 'modal-actions';
            const actionDefs = options.actions || [{ label: t('close'), value: null, className: 'btn ghost' }];
            actionDefs.forEach((def) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = def.className || 'btn';
                btn.textContent = def.label;
                if (def.danger) btn.classList.add('danger');
                btn.addEventListener('click', async () => {
                    if (typeof def.onClick === 'function') {
                        const handled = await def.onClick({ close, card, body });
                        if (handled === false) return;
                    }
                    close(def.value);
                });
                actions.appendChild(btn);
            });

            card.append(head, body, actions);
            root.appendChild(card);

            const focusTarget = card.querySelector('[autofocus]') || card.querySelector(focusableSelector);
            if (focusTarget) setTimeout(() => focusTarget.focus(), 0);
        });
    }

    function close(value, opts = {}) {
        if (!active || !root) return;
        const resolve = active.resolve;
        active = null;
        root.classList.remove('show');
        root.setAttribute('aria-hidden', 'true');
        root.innerHTML = '';
        if (opts.restoreFocus !== false && lastFocus && typeof lastFocus.focus === 'function') {
            lastFocus.focus();
        }
        resolve(value);
    }

    function alert(options = {}) {
        return open({
            title: options.title || '',
            body: options.body || '',
            wide: options.wide,
            actions: [{ label: options.okLabel || t('close'), value: true, className: 'btn ghost' }]
        });
    }

    function confirm(options = {}) {
        return open({
            title: options.title || '',
            body: options.body || '',
            actions: [
                { label: options.cancelLabel || t('cancel'), value: false, className: 'btn ghost' },
                { label: options.okLabel || t('ok'), value: true, className: options.danger ? 'btn danger' : 'btn' }
            ]
        });
    }

    function form(options = {}) {
        const formEl = document.createElement('form');
        formEl.className = 'modal-form';
        (options.fields || []).forEach((field, index) => {
            const wrap = document.createElement('div');
            wrap.className = 'field';
            const id = `modalField_${field.name || index}`;
            const label = document.createElement('label');
            label.setAttribute('for', id);
            label.textContent = field.label || field.name || '';
            const input = document.createElement('input');
            input.id = id;
            input.name = field.name || id;
            input.type = field.type || 'text';
            input.value = field.value || '';
            input.placeholder = field.placeholder || '';
            input.autocomplete = field.autocomplete || 'off';
            if (field.required) input.required = true;
            if (index === 0) input.autofocus = true;
            wrap.append(label, input);
            formEl.appendChild(wrap);
        });

        let submitButton = null;
        formEl.addEventListener('submit', (e) => {
            e.preventDefault();
            if (submitButton) submitButton.click();
        });

        const promise = open({
            title: options.title || '',
            body: formEl,
            actions: [
                { label: options.cancelLabel || t('cancel'), value: null, className: 'btn ghost' },
                {
                    label: options.submitLabel || t('save'),
                    value: 'submit',
                    className: 'btn',
                    onClick: () => {
                        const values = {};
                        for (const input of formEl.querySelectorAll('input')) values[input.name] = input.value.trim();
                        if (typeof options.validate === 'function') {
                            const ok = options.validate(values, formEl);
                            if (ok === false) return false;
                        }
                        close(values);
                        return false;
                    }
                }
            ]
        });
        submitButton = root.querySelector('.modal-actions .btn:not(.ghost)');
        return promise;
    }

    return { init, open, close, alert, confirm, form };
})();
