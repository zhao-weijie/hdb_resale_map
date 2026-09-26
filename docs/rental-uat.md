# Rental map acceptance checks

Verified on 25 September 2026 against the production Vite build in an isolated Chromium session. Implementation used GPT-5.6 Terra agents, followed by GPT-5.6 Sol code review and final UAT by the coordinating agent.

## Automated checks

- `npm test`: 53 tests across nine files passed.
- `npm run build`: passed TypeScript and production bundling. Vite retains a large-bundle advisory.
- `scripts/.venv/Scripts/python.exe -m unittest discover -s scripts -p test_build_rental.py`: four pipeline tests passed.
- `git diff --check`: passed.

## Browser checks

- Desktop 1440×900: rental modes, active flat type, evidence details, target overrides and financing assumptions work.
- Mobile 390×844 and narrow 320×800: persistent colour selector, bottom sheet, assumptions dialog and scrollable block details remain usable without horizontal page overflow.
- Switching active flat types updates the map and detail calculations.
- Panning retains the gross-yield scale (5.7%–9.7% for the tested 3-room scenario). Monthly-surplus colours have a symmetric scale centred on zero.
- Rental assets are lazy-loaded; subsequent metric switches do not refetch them.
- Blocking the rental manifest shows a visible failure and retry action. Resale mode remains available. Removing the network block and pressing Retry restores the rental map.
- Rental evidence uses the same single **From Month** control pattern as Global Filters. Applying a valid start month keeps the end fixed to the latest month shared by rental and resale data; unavailable start months are rejected without changing the active calculations.
- Selection geometry remains visible in rental mode. Icons render in the production build.
- Dialog dismissal, input validation, and scenario recalculation were exercised. Negative rent is rejected; an explicit Annual Value of zero is retained.

## Real-data reconciliation

Evidence window: January 2025–August 2026. Default scenario: purchase 25 September 2026, five years of qualifying occupation, 75% LTV, 25 years, 3% initial and future rates, 0% annual rent growth, 10% reserve. Monetary outputs below are rounded as displayed.

| Case | Evidence / expected result | Browser result |
| --- | --- | --- |
| Block 4 Holland Close, 3-room | 49 rental observations after one outlier exclusion; median rent $3,200. Six resale observations; median price $497,944. | Matches |
| Same block, default scenario | 7.7% gross yield; $1,771 mortgage payment; $5,280 annual property tax; $669 monthly property surplus; $134,524 initial capital. | Matches independent arithmetic |
| Same block, target price $600,000 and rent $3,000 | 6.0% gross yield; $2,134 mortgage payment; $4,800 annual property tax; $166 monthly property surplus; $163,100 initial capital. | Matches independent arithmetic |
| Same overrides, future rate 4%, rent growth −2%, Annual Value override zero | $2,707 projected rent; $2,332 mortgage payment; $105 monthly surplus. | Matches independent arithmetic |
| Block 310C Ang Mo Kio Avenue 1, 3-room | Three direct rents are thin; fallback uses 16 observations from three nearby blocks, median $3,000. | Nearby provenance and direct/fallback counts visible; after-tax surplus −$254/month |
| Block 4 Holland Close, 4-room | Rental evidence exists but only two resale observations. | Purchase estimate unavailable until a target price is supplied |

## Boundaries

The shipped rental snapshot contains 209,852 records through August 2026. These are block/type estimates, not identified units. Rent PSF uses resale floor area as a proxy.

Interest rates and five-year growth are editable assumptions, not forecasts. Annual Value defaults to a rent-based proxy. Personal income tax, CPF mechanics and the first five years' holding costs are outside the displayed cash-flow return. See the main README for sources and calculation boundaries.

This is local verification; no deployment was performed.
