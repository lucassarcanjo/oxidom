# rsdom micro benchmarks (fallback)

2026-10-17T03:17:16.013Z · Node v22.22.0 · Intel(R) Xeon(R) Processor @ 2.80GHz x4 · 5 processes per case and DOM (interleaved), median of 9 samples of ~100 ms each per process · git c4e213de00-dirty · addon release 325866fa4f24 · jsdom 30.1.3 · happy-dom 21.0.3 · vitest 5.0.5 · RSDOM_SHARED=0 RSDOM_BENCH_SAMPLES=9

| case (DESIGN §13 row) | metric | unit | jsdom | happy-dom | rsdom | rsdom vs best other |
|---|---|---|---:|---:|---:|---|
| mutate (1) | createElement + appendChild + removeChild | ns | 4063 | 2008 | 1071 (971-3252) | ~parity (ranges overlap) |
| mutate (1) | insertBefore first child + remove() (100 siblings) | ns | 4450 (4195-4867) | 2904 | 2027 (1382-2793) | ~parity (ranges overlap) |
| attr (2) | setAttribute | ns | 573 (527-598) | 1272 | 232 | 2.5x faster |
| attr (2) | getAttribute (unchanged) | ns | 184 | 25.9 (24.1-27.8) | 22.0 (17.7-24.8) | ~parity (ranges overlap) |
| attr (2) | hasAttribute (unchanged) | ns | 190 (185-211) | 23.9 | 33.2 (30.0-35.1) | 1.4x slower |
| attr (2) | setAttribute + getAttribute + hasAttribute, interleaved | ns/triple | 1021 (985-1103) | 1339 (1309-1452) | 446 | 2.3x faster |
| deep (3) | bottom-up detached build, 1001 nodes, depth 200, + attach | us | 84309 | 6386 | 951 (872-1059) | 6.7x faster |
| walk (4) | DFS firstChild/nextSibling/parentNode, 4096 nodes, steady | ns/node | 170 | 53.6 (50.7-63.5) | 35.1 (33.2-37.1) | 1.5x faster |
| walk (4) | same walk, interleaved: 1 setAttribute + 1 append/remove per walk | ns/node | 210 (194-232) | 70.3 (62.0-72.1) | 142 | 2.0x slower |
| walk (4) | childNodes[i] indexed read of a 100-child list | ns | 202 | 150 (140-155) | 137 | 1.1x faster |
| matches (9) | DTL role selectors x 565 elements, warm | ns/call | 2507 | 140 (128-190) | 27.6 | 5.1x faster |
| matches (9) | same, interleaved: 1 attribute + 1 child-list mutation per pass | ns/call | 2470 | 172 (133-189) | 30.6 | 5.6x faster |
| qsa (10) | querySelectorAll cold (after a mutation), 2709-element table | us/query | 2806 (2698-3590) | 2531 (1884-2821) | 46.8 (43.7-48.9) | 54x faster |
| qsa (10) | querySelectorAll warm (same query, no mutation) | us/query | 184 (178-199) | 0.209 (0.194-0.266) | 2.91 (2.75-5.61) | 14x slower |
| qsa (10) | querySelector #id-less first match, cold | us/query | 34.4 | 2.17 (2.04-2.67) | 0.713 (0.636-0.847) | 3.0x faster |
| gcs (12) | getComputedStyle(el).display, cold after a class mutation | ns | 511128 | 1084678 (1040363-1363890) | 1445 | 354x faster |
| gcs (12) | getComputedStyle(el).visibility, warm (no mutation) | ns | 2628 (2450-2978) | 327 (319-390) | 65.6 (62.4-110) | 5.0x faster |
| gcs (12) | 4 properties (display, color, margin-left, font-weight), cold after a class mutation | ns | 832864 (810561-926931) | 1080465 (1047605-1155796) | 2968 | 281x faster |
| gcs (12) | getPropertyValue("color"), cold after a class mutation | ns | 732320 (725066-856746) | 1137980 | 1997 | 367x faster |
| gcs (12) | display, cold after a class mutation, + 800-rule class-keyed sheet | ns | 625630 | 2042391 | 1479 (1441-1629) | 423x faster |
| gcs (12) | getPropertyValue("color"), cold after a class mutation, + 800-rule sheet | ns | 1390633 | 2173995 (1888600-2304693) | 2177 | 639x faster |
| focus (13) | focus() alternating between two inputs (blur/focusout/focus/focusin) | ns | 166106 | 9868 | 2858 | 3.5x faster |
| event (14) | new MouseEvent + dispatch, 20 levels, React-like listeners | ns | 17780 | 16187 (15255-17144) | 4232 (3972-4918) | 3.8x faster |
| parse (15) | innerHTML set, 300-row table | us | 45033 (41681-46736) | 46704 (43957-49028) | 3152 (3129-3650) | 14x faster |
| serialize (16) | outerHTML get, 300-row table, after a text mutation | us | 1436 (1395-1726) | 2424 (2257-2913) | 180 (165-195) | 8.0x faster |
| serialize (16) | textContent get, same table, after a text mutation | us | 309 (290-325) | 638 | 25.5 | 12x faster |
| mo (18) | observe + disconnect, 4096-node subtree (DTL waitFor options) | ns/pair | 2474 (2293-2582) | 812120 (802153-938694) | 370 (319-418) | 6.7x faster |
| mo (18) | appendChild + remove under an active subtree observer (records queued) | ns/pair | 10006 (8940-11310) | 6540 (6032-8221) | 1771 (1643-1916) | 3.7x faster |
| mo (18) | burst of 100 mutations -> one callback delivery (await microtask) | us/burst | 459 (445-546) | 307 (163-355) | 84.8 (79.4-91.8) | 3.6x faster |
| mem (19) | RSS per retained <div class> (100k, wrapper alive) | bytes | 2026 | 6599 | 408 | 5.0x less |
| mem (19) | V8 heap + external per retained <div class> | bytes | 2123 | 6404 | 104 | 20x less |
| mem (19) | V8 heap only per retained <div class> (not comparable: rsdom data lives outside V8) | bytes-nc | 2123 | 6404 | 98.5 | not comparable |
| mem (19) | churn: RSS growth per created-and-discarded node (2000 x innerHTML of 339 nodes, after gc) | bytes | 3.29 (2.30-7.56) | 0.393 (-0.296-5.61) | 173 | 440x more |
| env (17) | environment setup (import + window on globalThis), fresh process, in-process timing | ms | 705 (680-766) | 322 (280-421) | 37.1 (32.6-42.0) | 8.7x faster |
| env (17) |   of which: environment module import | ms-nc | 0.005 (0.004-0.009) | 0.005 (0.005-0.009) | 1.04 (0.800-1.32) | not comparable |
| env (17) |   of which: setup() | ms-nc | 705 (680-766) | 322 (280-421) | 36.0 (31.8-40.6) | not comparable |
| env (17) | environment teardown | ms | 0.648 (0.483-5.08) | 2.72 (1.07-3.46) | 1.02 (0.969-1.42) | ~parity (ranges overlap) |
| env-vitest (17) | Vitest environment phase per file (forks, isolate, maxWorkers=1) | ms | 713 | 314 (287-330) | 42.3 (39.4-51.0) | 7.4x faster |
| env-vitest (17) | vitest run wall, 6 trivial files (forks, maxWorkers=1) | ms | 5827 | 3419 (3191-3633) | 1693 (1622-1848) | 2.0x faster |
| react (react) | createRoot + render 1000-row table (flushSync) | ms | 184 (165-212) | 276 (242-301) | 92.0 (73.7-108) | 2.0x faster |
| react (react) | update: re-render with a new selected row | ms | 55.0 (53.4-59.2) | 66.5 (56.7-90.2) | 48.6 (43.0-68.6) | ~parity (ranges overlap) |
| testing-library (dtl) | getAllByRole("row") on a 1000-row table | ms | 265 (245-311) | 16.7 (15.7-18.3) | 3.28 (2.96-3.44) | 5.1x faster |
| testing-library (dtl) | getByRole("button", {name}) on the same table (accessible names) | ms | 218 | 22.2 (18.0-23.9) | 7.07 (6.49-7.59) | 3.1x faster |

Value = median over processes of each process's median; (a-b) = min-max across processes when wider than 10%; `!` = at least one process ran above the load threshold (re-run on an idle machine). A ratio is printed only when the process ranges of rsdom and the best other DOM do not overlap. rsdom never reclaims nodes inside an env: mutate / deep / parse rows exclude the freeing work GC-based DOMs pay; see the mem `churn` row for the memory side of that trade-off.
