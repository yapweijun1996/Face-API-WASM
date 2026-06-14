# TMS — UI/UX Layout Checklist

A practical, project-specific checklist for the TMS face-attendance app. Run through it **before merging any UI change** and **on every new screen**.

Each item ends with a concrete TMS finding (✅ already good / ❌ needs fix / ⚠️ verify on device), so this doubles as the audit log from the 2026-06-14 mobile-layout review.

> **The one rule above all rules:** Don't trust your eyes on a desktop window. Test at **320px** width and with the **longest** text (English copy is ~2× longer than Chinese). 9 of the 11 findings below are visible the instant you load TMS at 320px.

---

## Design Principles — the master framework（设计原则总纲）

Two complementary views. The **designer order** is how you *build* (abstract → pixel). The **engineering order** is how you *verify* (concrete → falsifiable). A healthy team uses both: design by the first, sign off by the second.

> **设计得对** 靠左边（设计师思考顺序）；**验证得了** 靠右边（工程验收清单，见 §0–§7）。缺一个都会漏。

### A. Designer thinking order — abstract to pixel（从用户目标到像素）

1. **Goals & users first（UX 根基）** — What task does this screen solve? Who is the persona, in what scenario? Define the **user flow** and **information architecture** before any visuals. Most layout problems are really unclear-requirements problems.
2. **Visual hierarchy（视觉层级）** — Guide the eye by importance using four tools: **size & weight**, **color & contrast** (make the primary action pop), **spacing** (whitespace is design, not waste), **position** (respect reading patterns — F/Z for LTR).
3. **Grid & alignment（网格对齐）** — Use a grid system (e.g. 12-col) + a **spacing scale** (4px / 8px multiples) so spacing has rhythm and is reusable, not eyeballed per value.
4. **Typography（排版）** — Set a type scale, line-height (~1.5 for body), measure (45–75 chars/line for LTR). Keep type roles few: heading / body / caption is usually enough.
5. **Consistency（一致性）** — Same function = same style. Build design tokens / a component library. Consistency lowers **cognitive load**.
6. **Responsive（响应式）** — Decide mobile-first vs desktop-first; define how layout reflows at breakpoints; touch targets ≥ 44px.
7. **Accessibility（可访问性）** — WCAG AA contrast ≥ 4.5:1; never rely on colour alone; keyboard nav; visible focus; alt text.
8. **Feedback & states（反馈与状态）** — Every interactive element: default / hover / active / focus / disabled / loading / error / **empty**. Beginners miss empty & error most.

> **One-line priority:** get **UX** right first (can the user finish the task?), *then* make **UI** beautiful with hierarchy + grid + consistency. A pretty interface nobody can use is a failed design.

### B. Three things the linear order hides（真实项目崩溃点的三点补充）

The 8 steps above are the *ideal forward path*. Real layouts break at the **edges**, not the average case. Add these:

- **B1. Constraints first（约束优先）** — Quality is set by the **worst case**, not the typical one. Before hierarchy, pin down the four hardest constraints: **narrowest screen** (320px), **longest copy** (longest i18n language), **weakest environment** (slow net/device), **worst physical condition** (for TMS: backlight / low light / multiple faces — these decide whether the app *works at all*). **Design the failure before the success.**
- **B2. State has two scales（状态有两个尺度）** — The states in step 8 are all **element-level**. There is also a **system / flow level** that element states can never cover: **flow dead-ends** (user enters a state with no exit — *TMS's 60s cooldown trap is exactly this*), **concurrency** (multiple people clocking at once), **time states** (session/cooldown expiry). Every element can look fine while the *system* traps the user.
- **B3. Copy length is a layout variable（文案长度是布局变量）** — Typography (step 4) covers *style*; it misses that **string length itself is a layout input**. English ≈ 1.5–2× Chinese. **9 of TMS's 11 issues stem from this.** Pro practice: stress-test layout with the **longest language's longest string**, never lorem ipsum or the developer's short native copy — those give false confidence.

### Two views, mapped

| Designer order (build) | Engineering order (verify) |
|---|---|
| Goals → IA → hierarchy → grid → type → consistency → responsive → a11y → states | 320px device + longest copy → tick each checkbox → mark ❌/✅/⚠️ |
| Abstract → concrete | Concrete → falsifiable |
| Used **while designing** | Used **at sign-off** (§0–§7 below) |

---

## 0. Process — how to actually verify

- [ ] Open in Chrome DevTools device mode at **320px** (smallest real phone) AND **375px** (iPhone SE/mini).
- [ ] Toggle language to **English** (longest copy) before judging overflow.
- [ ] Toggle **both** light and dark theme (contrast differs).
- [ ] Test with **realistic data**: 15+ staff (pill widens), long names, 100+ records.
- [ ] Rotate to landscape on a short-height phone (modals must still fit).

---

## 1. Content priority — design attention, not boxes

One screen = **one** primary action. Everything else is secondary and should look secondary.

- [ ] Each screen has a single, obvious primary action.
- [ ] Secondary controls are visually de-emphasised (ghost buttons, smaller, lower).
- [ ] Dense screens are chunked into clearly separated cards/sections.

**TMS findings**
- ✅ Clock page is focused: camera + auto clock-in is the clear hero.
- ⚠️ **Records panel overloads one screen**: filter + table + pager + AI-verify + schedule + sensitivity + sound settings all stacked with equal weight. Consider moving Schedule / Sensitivity / Sound into a dedicated **Settings** tab. *(acknowledged; deferred as UX-scope refactor, not a layout bug)*

---

## 2. Responsive / mobile-first — design the narrowest screen first

Build for 320px first, then **add** at larger breakpoints — never shrink a desktop layout down.

- [ ] Every container holds the **longest** localized string without breaking layout.
- [ ] Long text wraps: `overflow-wrap: break-word` (and `min-width: 0` on flex children).
- [ ] Fixed multi-column grids (`repeat(N, 1fr)`) have a single-column fallback at a mobile breakpoint.
- [ ] No element relies on a desktop-only width to look right.

**TMS findings**
- ✅ **`header h1` / `.pill`** — added `min-width:0; overflow:hidden; text-overflow:ellipsis` to `h1`; `.pill` hides at `≤380px`. Verified at 320px dark + light. *(fixed 2026-06-14)*
- ✅ **`.stat-row`** — added `@media (max-width:480px)` breakpoint reducing `.stat-num` to `24px`. Verified 3-col fits at 320px. *(fixed 2026-06-14)*
- ✅ **`.toggle-desc`** — added `overflow-wrap:break-word; word-break:break-word`. Long EN liveness text wraps without horizontal blowout at 320px. *(fixed 2026-06-14)*

---

## 3. Box model & native controls — the silent overflow source

- [ ] Global `box-sizing: border-box` is set (so `width:100%` + padding never overflows).
- [ ] Spacing uses **one scale** (4 / 8 / 12 / 16 / 24…), not ad-hoc `7px`, `14px`, `6px`.
- [ ] Native controls (`input[type=time|number|date]`, `select`) are reset with `appearance: none` — iOS gives them an intrinsic min-width and chrome that ignores `width:100%`.

**TMS findings**
- ✅ `* { box-sizing: border-box }` is present.
- ✅ **`input[type="time"]` in `.sched-grid`** — fixed with `-webkit-appearance:none; appearance:none; min-width:0; width:100%` on inputs AND `min-width:0` on `.sched-grid .field` (the grid item). Root cause: `1fr` columns can't shrink below the grid item's min-content size; fix must be on the item, not just the input. Verified at 320px: columns 121px each, no overflow. *(fixed 2026-06-14)*
- ✅ **Inline-styled selects** — consolidated to `.field select` class with `appearance:none`, right-padding 36px, and per-theme SVG chevrons. *(fixed 2026-06-14)*
- ⚠️ Spacing is mostly consistent but mixes `6/7/8/10/14px` in places — fine, but worth standardising on an 8px scale over time.

---

## 4. Consistency — single source of truth (SSOT)

- [ ] Colours, radii, font sizes, button styles all come from **tokens** (CSS variables), not hardcoded per element.
- [ ] One meaning = one visual everywhere (green = on-duty/in, red = out, consistent across overlay, table, badges).
- [ ] No inline styles that duplicate what a class already does.

**TMS findings**
- ✅ Strong token system (`--in`, `--out`, `--line`, `--accent`…) with light/dark variants. Canvas overlay colours are even synced from the same CSS vars in `applyTheme()`.
- ✅ **Inline-styled selects** — consolidated into `.field select` class with `appearance:none`, custom SVG chevron for dark (`%2394a3b8`) and light (`%2364748b`) themes. Verified chevron visible in both themes. *(fixed 2026-06-14)*

---

## 5. Touch & accessibility

- [ ] Touch targets ≥ **44×44px** (Apple HIG).
- [ ] Text contrast ≥ **4.5:1** (test `--muted` text in BOTH themes).
- [ ] Interactive elements are keyboard-reachable and have `aria-label` where icon-only.
- [ ] Focus states are visible.

**TMS findings**
- ✅ **`.emp-action`** — bumped to `padding:10px; min-width:44px; min-height:44px; display:inline-grid; place-items:center`. *(fixed 2026-06-14)*
- ⚠️ **`nav button`** — still at ~40px tall; acceptable for PWA nav bar but worth a follow-up bump to 44px.
- ✅ Icon-only buttons (theme, image viewer, close) have `aria-label`.
- ⚠️ `--muted` on `--card` in **light** theme — verify it clears 4.5:1.

---

## 6. Feedback & state — the most-missed dimension

Every action needs four states: **default / in-progress / success / error** — and never a dead end.

- [ ] Loading, empty, success, and error states are all designed (not just the happy path).
- [ ] The user always has an **escape hatch** out of any stuck state.
- [ ] State changes are announced (toast, badge, colour, sound).

**TMS findings**
- ✅ **Refresh button added to Clock page** — calls `cooldown.clear()` + `stopCamera()` + `lastClockKey=null` + camera restart. Ghost-style button with refresh icon; i18n key `refresh_btn`. Verified renders correctly at 320px light+dark. *(fixed 2026-06-14)*
- ✅ **Manual clock fallback added** — `#clockManualBtn` rendered by `renderClockStatus()` when a clock action is pending; stores `pendingManualCtx` and calls `doClock()` on tap. Hides when no pending action. *(fixed 2026-06-14)*
- ✅ Toasts, celebration particles, beep/voice, and the AI-verify modal cover most other feedback well.

---

## 7. Error prevention & recovery

- [ ] Destructive actions require confirmation.
- [ ] Errors are recoverable — never trap the user.
- [ ] Fail-open vs fail-closed is a deliberate decision, surfaced to the user.

**TMS findings**
- ✅ "Clear records", "Delete staff", bulk delete all confirm first.
- ✅ AI liveness is deliberately **fail-open** (LM Studio unreachable → clock-in still works, with a toast).
- ✅ Cooldown dead-end resolved by the Refresh button (see §6). *(fixed 2026-06-14)*

---

## Findings summary (2026-06-14 audit) — all resolved

| # | Area | Severity | Status | Item |
|---|------|----------|--------|------|
| 1 | Clock | **High** | ✅ Fixed | Refresh button added; clears cooldown + restarts camera |
| 2 | Clock | Med | ✅ Fixed | Manual clock-in/out button (`#clockManualBtn`) added |
| 3 | Header | Med | ✅ Fixed | `h1` gets `min-width:0; text-overflow:ellipsis`; pill hides at ≤380px |
| 4 | Dashboard | Med | ✅ Fixed | `@media (max-width:480px)` reduces `.stat-num` to 24px |
| 5 | Records | Low | ✅ Fixed | EN placeholder shortened to "Search name, type, date…" |
| 6 | Records | Low | ✅ Fixed | `.records-page-size` `min-width` reduced to `90px` |
| 7 | Records | Low | ✅ Fixed | Pager buttons already fit at 320px; verified |
| 8 | Settings | Med | ✅ Fixed | `.toggle-desc` gets `overflow-wrap:break-word; word-break:break-word` |
| 9 | Settings | **Med** | ✅ Fixed | `.sched-grid .field { min-width:0 }` + `input width:100%` — no overflow at 320px |
| 10 | Settings | Med | ✅ Fixed | `.field select` unified with `appearance:none` + data-URI chevron SVGs |
| 11 | Records | Low | ✅ Fixed | `@media (max-width:480px)` hides table columns 5 & 6 |

**Remaining ⚠️ items (not blocking, deferred):**
- Nav button touch targets (~40px vs ideal 44px)
- `--muted` contrast ratio in light theme (needs Lighthouse/DevTools contrast check)
- Records panel UX refactor (move Schedule/Sensitivity/Sound to dedicated Settings tab)

---

*Generated from a codebase audit of `examples/TMS/` (index.html, tms-app.js, tms-i18n.js, tms-db.js) on 2026-06-14.*
