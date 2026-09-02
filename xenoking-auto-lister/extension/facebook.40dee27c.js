var e, t;
"function" == typeof(e = globalThis.define) && (t = e, e = null),
function(t, r, o, n, a) {
    var i = "undefined" != typeof globalThis ? globalThis : "undefined" != typeof self ? self : "undefined" != typeof window ? window : "undefined" != typeof global ? global : {},
        l = "function" == typeof i[n] && i[n],
        s = l.cache || {},
        c = "undefined" != typeof module && "function" == typeof module.require && module.require.bind(module);

    function u(e, r) {
        if (!s[e]) {
            if (!t[e]) {
                var o = "function" == typeof i[n] && i[n];
                if (!r && o) return o(e, !0);
                if (l) return l(e, !0);
                if (c && "string" == typeof e) return c(e);
                var a = Error("Cannot find module '" + e + "'");
                throw a.code = "MODULE_NOT_FOUND", a
            }
            d.resolve = function(r) {
                var o = t[e][1][r];
                return null != o ? o : r
            }, d.cache = {};
            var g = s[e] = new u.Module(e);
            t[e][0].call(g.exports, d, g, g.exports, this)
        }
        return s[e].exports;

        function d(e) {
            var t = d.resolve(e);
            return !1 === t ? {} : u(t)
        }
    }
    u.isParcelRequire = !0, u.Module = function(e) {
        this.id = e, this.bundle = u, this.exports = {}
    }, u.modules = t, u.cache = s, u.parent = l, u.register = function(e, r) {
        t[e] = [function(e, t) {
            t.exports = r
        }, {}]
    }, Object.defineProperty(u, "root", {
        get: function() {
            return i[n]
        }
    }), i[n] = u;
    for (var g = 0; g < r.length; g++) u(r[g]);
    if (o) {
        var d = u(o);
        "object" == typeof exports && "undefined" != typeof module ? module.exports = d : "function" == typeof e && e.amd ? e(function() {
            return d
        }) : a && (this[a] = d)
    }
}({
    eZj0B: [function(e, t, r) {
        var o = e("~common/browserMethods");
        let xkAbortRemove = !1;
        async function xkRemoveListings(titles, action, all) {
            xkAbortRemove = !1;
            let sleep = e => new Promise(t => setTimeout(t, e)),
                norm = e => String(e || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
                want = (titles || []).map(norm).filter(Boolean),
                allMode = !!all || 0 === want.length,
                isDel = "delete" === action,
                click = e => { try { e.scrollIntoView({ block: "center" }) } catch (t) {} e.dispatchEvent(new MouseEvent("click", { bubbles: !0, cancelable: !0, view: window })) },
                prog = (i, n, t, ok) => { try { chrome.runtime.sendMessage({ message: "xkRemoveProgress", current: i, total: n, title: t, ok: ok }) } catch (e) {} };
            if (!/\/marketplace\/you/.test(location.href)) return { ok: !1, error: "Open Facebook → Marketplace → Your Listings, then try again." };
            let waitFor = async (fn, ms, step) => { for (let t0 = 0; t0 < (ms || 3e3); t0 += step || 60) { let v = fn(); if (v) return v; await sleep(step || 60) } return null },
                menuOpen = () => document.querySelector('[role="menu"]'),
                dialogOpen = () => document.querySelector('[role="dialog"]'),
                menuItem = labels => { let items = Array.from(document.querySelectorAll('[role="menuitem"],[role="menu"] [role="button"],div[role="button"],span')); for (let lb of labels) { let it = items.find(x => norm(x.innerText || x.textContent).includes(norm(lb)) && (x.innerText || "").length < 40); if (it) return it } return null },
                confirmBtn = labels => { let btns = Array.from(document.querySelectorAll('[role="dialog"] [role="button"],[role="dialog"] button')); for (let lb of labels) { let b = btns.find(x => norm(x.innerText || x.textContent) === norm(lb)); if (b) return b } return null },
                actionBtns = () => Array.from(document.querySelectorAll('[aria-label*="ctions for" i],[aria-label*="More options" i],[aria-label*="More" i],[aria-haspopup="menu"]')).filter(b => b instanceof HTMLElement && null !== b.offsetParent),
                removed = 0;
            // ALL mode: operate on every listing card on the Facebook page, independent of our internal log.
            // Adaptive: wait only as long as each menu/dialog actually needs — no fixed multi-second sleeps.
            if (allMode) {
                let done = 0, guard = 0, misses = 0;
                for (; guard < 2e3; guard++) {
                    if (xkAbortRemove) break;
                    let mb = actionBtns().find(b => !b.__xkDone);
                    if (!mb) { window.scrollTo(0, document.body.scrollHeight); await sleep(500); mb = actionBtns().find(b => !b.__xkDone); if (!mb) { window.scrollTo(0, 0); break } }
                    mb.__xkDone = !0;
                    click(mb);
                    let item = await waitFor(() => menuOpen() && menuItem(isDel ? ["Delete listing", "Delete"] : ["Mark as sold", "Mark as Sold", "Mark sold"]), 2200, 55);
                    if (!item) { document.body.click(); await sleep(120); if (++misses > 12 && 0 === done) return { ok: !1, error: "Couldn't open the listing menus — make sure you're on Marketplace → Your Listings." }; continue }
                    misses = 0; click(item);
                    let cf = await waitFor(() => { let d = dialogOpen(); return d ? confirmBtn(isDel ? ["Delete", "Delete listing"] : ["Mark as sold", "Mark as Sold", "OK", "Confirm", "Done"]) : null }, 2200, 55);
                    if (cf) { click(cf); await waitFor(() => !dialogOpen(), 3500, 90) } else await sleep(120);
                    done++, prog(done, done, (isDel ? "Deleted " : "Marked sold ") + done, !0), await sleep(180)
                }
                return { ok: !0, removed: done, total: done }
            }
            // Title mode: pre-load all listings so titles can be matched.
            let last = 0;
            for (let e = 0; e < 25; e++) { window.scrollTo(0, document.body.scrollHeight); await sleep(700); if (document.body.scrollHeight === last && e > 3) break; last = document.body.scrollHeight }
            window.scrollTo(0, 0); await sleep(500);
            for (let idx = 0; idx < want.length; idx++) {
                let target = want[idx],
                    cands = Array.from(document.querySelectorAll("div")).filter(d => { let t = norm(d.innerText); return t && t.length < 400 && t.includes(target) }).sort((a, b) => (a.innerText || "").length - (b.innerText || "").length),
                    card = null;
                for (let c of cands) { if (c.querySelector('[aria-label*="ctions" i],[aria-label*="More" i],[aria-haspopup="menu"],[aria-label*="options" i]')) { card = c; break } }
                if (!card) { console.warn("[XK Remove] not found:", target); prog(idx + 1, want.length, target, !1); continue }
                let mb = card.querySelector('[aria-label*="ctions" i],[aria-label*="More" i],[aria-haspopup="menu"],[aria-label*="options" i]');
                click(mb); await sleep(750);
                let item = menuItem(isDel ? ["Delete listing", "Delete"] : ["Mark as sold", "Mark as Sold", "Mark sold"]);
                if (!item) { console.warn("[XK Remove] menu item not found:", target); document.body.click(); await sleep(300); prog(idx + 1, want.length, target, !1); continue }
                click(item); await sleep(850);
                let cf = confirmBtn(isDel ? ["Delete"] : ["Mark as sold", "Mark as Sold", "OK", "Confirm", "Done"]);
                cf && (click(cf), await sleep(1400)), removed++, prog(idx + 1, want.length, target, !0), await sleep(1500)
            }
            return { ok: !0, removed: removed, total: want.length }
        }
        console.log("Hello from the Facebook content script"), chrome.runtime.onMessage.addListener(function(e, xkSender, xkRespond) {
            let {
                message: t,
                vehicle: r,
                localStorage: n,
                whereToPost: a
            } = e;
            if ("xkStopRemove" === t) return xkAbortRemove = !0, xkRespond({ ok: !0 }), !0;
            if ("xkRemoveListings" === t) return xkRemoveListings(e.titles || [], e.action || "sold", !!e.all).then(xkRespond).catch(e => xkRespond({ ok: !1, error: String(e && e.message || e) })), !0;
            if ("runFBScript" === t) return (async () => {
                try {
                    "FB Marketplace" === a && (await (0, o.postToFbMarketplace)(r, n), console.log("Vehicle posted to Facebook Marketplace:", r)), ("FB Groups" === a || "FB Page" === a) && (await chrome.storage.local.set({
                        insertableVehicleData: r
                    }), console.log("Vehicle data stored for FB Groups/Page:", r)), console.log("Local storage data:", n)
                } catch (e) {
                    console.error("[FB Content Script] runFBScript error:", e)
                } finally {
                    try {
                        chrome.runtime.sendMessage({
                            message: "fbPostFilled",
                            vin: r && (r.VIN || r.vin) || ""
                        })
                    } catch (e) {}
                }
            })(), !0
        })
    }, {
        "~common/browserMethods": "92Ssc"
    }],
    "92Ssc": [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        o.defineInteropFlag(r), o.export(r, "isVinPresent", () => D), o.export(r, "updateSoldVehiclesWithPresence", () => U), o.export(r, "AIDescription", () => I), o.export(r, "preparePromptForOpenAI", () => $), o.export(r, "cleanLocalStorageObject", () => F), o.export(r, "postToFbMarketplace", () => M), o.export(r, "updateActiveTabUrl", () => x), o.export(r, "updateCurrentPageUrl", () => A), o.export(r, "setLocalStorage", () => m), o.export(r, "getLocalStorage", () => f), o.export(r, "tabMessage", () => w), o.export(r, "runTimeMessage", () => b), o.export(r, "setBlobStorage", () => h), o.export(r, "getBlogStorage", () => y), o.export(r, "getBlobFromImgUrl", () => p), o.export(r, "asyncSleep", () => O);
        var n = e("webextension-polyfill"),
            a = o.interopDefault(n),
            i = e("~imagesUpload/images"),
            l = e("~utils/ai"),
            s = e("~utils/aiAttributes"),
            c = e("~utils/humanInteraction");
        let u = "social_auto_group",
            g = a.default.storage.local;
        async function d(e) {
            return new Promise((t, r) => {
                let o = new FileReader;
                o.onloadend = () => t(o.result), o.readAsDataURL(e)
            })
        }
        let p = async e => {
            let t = new AbortController,
                r = setTimeout(() => t.abort(), 3e4);
            try {
                let o = await fetch(e, {
                    signal: t.signal
                });
                if (clearTimeout(r), !o.ok) throw Error(`Failed to fetch image from ${e}: ${o.status} ${o.statusText}`);
                let n = await o.blob();
                if (n.size > 26214400) throw Error(`Image size exceeds 25 MB for ${e}`);
                return await d(n)
            } catch (t) {
                if (clearTimeout(r), "AbortError" === t.name) throw Error(`Image fetch timeout for ${e}`);
                throw t
            }
        };
        async function m(e) {
            await g.set({
                [u]: e
            })
        }
        async function f() {
            let e = await g.get();
            return e[u]
        }
        async function h(e) {
            await g.set({
                imageBlog: e
            })
        }
        async function y() {
            let e = await g.get();
            return e.imageBlog
        }
        async function w(e) {
            let t = await (0, a.default).tabs.query({
                active: !0
            });
            return await (0, a.default).tabs.sendMessage(t[0].id, {
                ...e
            })
        }
        async function b(e) {
            try {
                let t = await (0, a.default).runtime.sendMessage(e);
                return t
            } catch (e) {
                throw console.error("Runtime message error:", e), e
            }
        }
        async function A(e) {
            let t = await (0, a.default).tabs.query({
                active: !0
            });
            (0, a.default).tabs.update(t[0].id, {
                url: e
            })
        }
        let k = e => {
            try {
                if ("string" != typeof e) return e?.toString() || "";
                return e?.replace(/\\|"|\\r/g, "")
            } catch (e) {
                return console.error("Error cleaning string:", e), ""
            }
        };
        async function x(e) {
            let t = await (0, a.default).tabs.query({
                active: !0
            });
            await (0, a.default).tabs.update(t[0]?.id, {
                url: e
            }), await v(t[0]?.id)
        }
        let C = (e, t) => {
            try {
                let r = Array.from(document.querySelectorAll(e));
                return r?.find(e => e instanceof HTMLElement && e?.innerText.trim() === t)
            } catch (e) {
                return console.error("Error finding element:", e), null
            }
        };
        async function v(e) {
            await O(.5);
            let t = await (0, a.default).tabs.get(e);
            if ("loading" != t.status) return e;
            await v(e)
        }
        let T = e => {
                if (!e) return null;
                let t = e.querySelector("input, textarea");
                if (t) return t;
                let r = e.parentElement;
                if (r) {
                    let e = r.querySelector("input, textarea");
                    if (e) return e
                }
                return null
            },
            _ = (e, t) => {
                let r = "TEXTAREA" === e.tagName ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
                    o = Object.getOwnPropertyDescriptor(r, "value")?.set;
                o ? o.call(e, t) : e.value = t, e.dispatchEvent(new Event("input", {
                    bubbles: !0
                })), e.dispatchEvent(new Event("change", {
                    bubbles: !0
                }))
            },
            E = async (e, t) => {
                if (!e) return;
                let r = T(e);
                if (!r) return e?.focus(), void document.execCommand("insertText", !1, t);
                // Set, then verify the value actually stuck (React can revert it) and retry.
                for (let n = 0; n < 3; n++) {
                    await O(.08 + .08 * Math.random()), r.focus(), await O(.05 + .05 * Math.random()), _(r, t), await O(.1 + .1 * Math.random());
                    let a = String(r.value == null ? "" : r.value).trim(),
                        o = String(t == null ? "" : t).trim();
                    if (a === o || "" !== a && a.includes(o) || "" === o) return;
                    console.warn("[Marketplace] field didn't stick, retrying:", o, "got:", a)
                }
            };
        async function S(e, t = 3e4, r = 500) {
            let o = Date.now() + t;
            for (; Date.now() < o;) {
                let t = document.querySelector(e);
                if (t) return t;
                await new Promise(e => setTimeout(e, r))
            }
            return null
        }
        async function M(e, t) {
            let r, o, n, u, g;
            let {
                Make: d,
                Model: p,
                Year: m,
                Price: f,
                Title: h,
                stock_number: y,
                Description: w,
                VIN: b,
                MileageValue: A,
                ImageUrls: x,
                Trim: v,
                ExteriorColor: T,
                InteriorColor: _,
                BodyStyle: M,
                Drivetrain: I,
                engine: F,
                StateofVehicle: $,
                HardcodedDescription: U
            } = e;
            console.log("[Marketplace] HardcodedDescription:", U), console.log(e, "vehicle");
            let D = "Seller Notes: ",
                L = "",
                N = {
                    body_style: "Other",
                    exterior_color: "Black",
                    interior_color: "Black",
                    fuel_type: "Gasoline"
                },
                R = "";
            v && (L = v);
            let P = C("label", "Vehicle type");
            await S('[aria-label="Preview"]', 3e4, 500);
            // Cold-start guard (especially the first post): the Preview can render before the
            // form fields hydrate. Wait until the key labels actually exist, then re-grab them.
            for (let xr = 0; xr < 24 && !C("label", "Vehicle type") && !C("label", "Make"); xr++) await O(.5);
            await O(.5), P = C("label", "Vehicle type") || P;
            let B = e.OriginalDescription || "",
                j = B;
            j && "" !== j.trim() || (j = h);
            let q = `Year: ${m}
Make: ${d}
Model: ${p}
Trim: ${L||"Not specified"}
Price: ${f}
Mileage: ${A}
VIN: ${b}
Stock Number: ${y||"Not specified"}
Exterior Color: ${T||"Not specified"}
Interior Color: ${_||"Not specified"}
Body Style: ${M||"Not specified"}
Drivetrain: ${I||"Not specified"}
Engine: ${F||"Not specified"}
Title: ${h}
StateofVehicle: ${$||"Not specified"}
Description: ${j||"Not provided"}`;
            t && (r = t.vehicleCategory, u = t.shouldAddStockNumber, g = t.isAiDescription, D = t.description), D || (D = ".");
            let V = await (0, a.default).storage.local.get("emoji");
            n = V.emoji?.replace(/\"/g, "") || "";
            let H = await (0, a.default).storage.local.get("mileUnit");
            o = H.mileUnit?.replace(/\"/g, "") || "Miles";
            let xkSMv = await (0, a.default).storage.local.get("salesManName"),
                xkSM = xkSMv.salesManName?.replace(/\"/g, "").trim() || "";
            let xkNum = t => String(t == null ? "" : t).replace(/[^\d]/g, "").replace(/\B(?=(\d{3})+(?!\d))/g, ","),
                xkMoney = t => { let e = xkNum(t); return e ? "$" + e : "" };
            let xkVName = [m, d, p].filter(Boolean).join(" "),
                xkVKind = (e => /truck|pickup/.test(e) ? "truck" : /suv|sport ut|crossover|utility/.test(e) ? "suv" : /van/.test(e) ? "van" : "car")(String(M || "").toLowerCase()),
                xkVPick = e => e[Math.floor(Math.random() * e.length)],
                xkVOpener = xkVPick([
                    `\ud83d\ude97 Clean ${xkVName} \u2014 ready for a new home!`,
                    `\ud83d\udd25 This ${xkVName} won't last long!`,
                    `\ud83d\udc40 Come check out this ${xkVName}!`,
                    `\u2728 Sharp ${xkVName}, priced to move!`,
                    `\ud83d\udc8e Just hit the lot: ${xkVName}!`,
                    `\ud83c\udfc1 ${xkVName} \u2014 runs and drives excellent!`,
                    `\u2b50 Don't sleep on this ${xkVName}!`,
                    `\ud83d\udce3 Priced to sell: ${xkVName}!`
                ].concat({
                    truck: [`\ud83d\udcaa Work-ready ${xkVName} \u2014 tows, hauls, does it all!`, `\ud83d\udefb Built to work AND play \u2014 ${xkVName}!`],
                    suv: [`\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 Room for the whole crew \u2014 ${xkVName}!`, `\ud83c\udfd4\ufe0f Adventure-ready ${xkVName}!`],
                    van: [`\ud83d\udce6 Space for days \u2014 ${xkVName}!`],
                    car: [`\u26fd Easy on gas, sharp on looks \u2014 ${xkVName}!`]
                }[xkVKind] || [])),
                xkVCTA = xkVPick([
                    "\ud83d\udce9 Message us or stop in for a test drive today!",
                    "\ud83d\udce9 DM for a quick walkaround video or to book a test drive!",
                    "\ud83e\udd1d Financing options available \u2014 message us to get started!",
                    "\ud83d\udea6 First come, first served \u2014 message now to lock it in!",
                    "\ud83d\udcc5 Schedule your test drive today \u2014 it's easy!"
                ]);
            let G = !0 === g || "true" === g,
                z = [
                    `${[m,d,p,L].filter(Boolean).join(" ")} ${n||"\ud83d\udd25"}`.trim(),
                    "",
                    xkVOpener,
                    "",
                    f ? `\ud83d\udcb0 Price: ${xkMoney(f)||f}` : null,
                    A ? `\ud83d\udee3\ufe0f Mileage: ${xkNum(A)||A} ${o}` : null,
                    I ? `\u2699\ufe0f Drivetrain: ${I}` : null,
                    F ? `\ud83d\udd27 Engine: ${F}` : null,
                    T ? `\ud83c\udfa8 Exterior: ${T}` : null,
                    _ ? `\ud83e\ude91 Interior: ${_}` : null,
                    y ? `\ud83d\udd16 Stock #: ${y}` : null,
                    b ? `\ud83d\udd11 VIN: ${b}` : null,
                    "",
                    xkVCTA,
                    xkSM ? `\ud83d\udcde Call the dealership and ask for ${xkSM}!` : null
                ].filter(e => null !== e).join("\n");
            let xkHasNote = D && "." !== D.trim() && "" !== D.trim();
            R = xkHasNote ? (G ? z + "\n\n" + D.trim() : D + (xkSM ? "\n\n📞 Call the dealership and ask for " + xkSM + "!" : "")) : z;
            // Map a dealer paint name ("Iridescent Pearl Tricoat") to Facebook's
            // fixed colour list; twin() bridges the Grey/Gray locale spelling.
            let xkFbColor = e => {
                    let t = String(e || "").toLowerCase();
                    if (!t) return "";
                    if (/white|ivory|cream|frost/.test(t)) return "White";
                    if (/black|ebony|onyx|jet|midnight/.test(t)) return "Black";
                    if (/silver|billet|platinum/.test(t)) return "Silver";
                    if (/gr[ae]y|granite|graphite|charcoal|slate|gunmetal|steel|ceramic|titanium/.test(t)) return "Grey";
                    if (/red|burgundy|maroon|crimson|ruby|garnet|velvet|cherry/.test(t)) return "Red";
                    if (/blue|navy|sapphire|cobalt|hydro/.test(t)) return "Blue";
                    if (/green|emerald|olive|sage|gecko/.test(t)) return "Green";
                    if (/brown|mocha|espresso|chocolate|bronze|copper|walnut/.test(t)) return "Brown";
                    if (/tan\b|beige|sand|champagne|khaki|linen/.test(t)) return "Tan";
                    if (/gold/.test(t)) return "Gold";
                    if (/orange|mango|sunset/.test(t)) return "Orange";
                    if (/yellow|banana/.test(t)) return "Yellow";
                    if (/purple|plum|violet/.test(t)) return "Purple";
                    if (/pink|rose/.test(t)) return "Pink";
                    if (/pearl/.test(t)) return "White";
                    return ""
                },
                xkColorTwin = e => "Grey" === e ? "Gray" : "Gray" === e ? "Grey" : e;
            try {
                await (0, c.humanClick)(P), await O(.3);
                let xkTypeMap = {
                        "Car/Truck": ["Car/van", "Car/Truck", "Car/Van"],
                        Powersport: ["Power sport", "Powersport"],
                        "RV/Camper": ["Motorhome/caravan", "RV/Camper"]
                    },
                    xkWanted = k(r) || "Other",
                    xkCands = xkTypeMap[xkWanted] || [xkWanted],
                    e = null;
                for (let xkTry = 0; xkTry < 4 && !e; xkTry++) {
                    for (let xkLabel of xkCands)
                        if (e = C("span", xkLabel)) break;
                    e || await O(.4)
                }
                e || (e = C("span", "Other")), console.log("[Marketplace] Vehicle type option clicked:", e && e.innerText), await (0, c.humanClick)(e), await (0, c.waitUserDelay)()
            } catch (e) {
                console.error("[Marketplace] Error selecting vehicle type:", e)
            }
            try {
                let e = C("label", "Year");
                await (0, c.humanClick)(e), await O(.3);
                let t = (m || "").toString().trim(),
                    r = C("span", k(t) || "2022");
                await (0, c.humanClick)(r), await (0, c.waitUserDelay)()
            } catch (e) {
                console.error("[Marketplace] Error selecting year:", e)
            }
            let W = "";
            if ("Car/Truck" === r) {
                try {
                    let e = await (0, s.extractAttributesFromDescription)(q);
                    e && (N = {
                        body_style: e.body_style || N.body_style,
                        exterior_color: e.exterior_color || N.exterior_color,
                        interior_color: e.interior_color || N.interior_color,
                        fuel_type: e.fuel_type || N.fuel_type
                    })
                } catch (e) {
                    console.error("[Car/Truck] Error extracting AI attributes:", e)
                }
                console.log("=== [Car/Truck] Starting Make Selection ==="), console.log("[Car/Truck] Target Make:", d);
                try {
                    let e = C("label", "Make");
                    if (!e) throw console.error("[Car/Truck] Make label not found"), console.error("[Car/Truck] Available labels on page:", Array.from(document.querySelectorAll("label")).map(e => e.textContent)), Error("Make label element not found");
                    console.log("[Car/Truck] Make label found:", e.textContent, "Element:", e), console.log("[Car/Truck] Closing any open dropdowns before opening Make...");
                    let t = document.querySelectorAll('[aria-expanded="true"][role="combobox"]');
                    if (t.length > 0) {
                        console.log("[Car/Truck] Found", t.length, "open dropdown(s), closing them...");
                        let e = document.body;
                        e && (e.click(), await O(.2))
                    }
                    console.log("[Car/Truck] Clicking Make label..."), await (0, c.humanClick)(e), console.log("[Car/Truck] Clicked Make label, waiting for dropdown...");
                    let r = "";
                    try {
                        r = ["SRT", "MINI", "CODA", "BMW", "GMC", "Land Rover"].includes(d) ? d : d ? d.split(" ").map(e => e.charAt(0).toUpperCase() + e.slice(1).toLowerCase()).join(" ") : "Toyota"
                    } catch (e) {
                        console.error("[Car/Truck] Error processing Make:", e), r = d || "Toyota"
                    }
                    console.log("[Car/Truck] Original Make:", d, "Processed Make:", r), console.log("[Car/Truck] Looking for Make option:", r);
                    let o = !1,
                        n = null,
                        a = null;
                    for (let t = 0; t < 10; t++) {
                        await O(.2);
                        let r = "true" === e.getAttribute("aria-expanded");
                        if (r && !a && (a = e.getAttribute("aria-controls"), console.log("[Car/Truck] Make label expanded, aria-controls:", a)), a && (n = document.getElementById(a))) {
                            o = !0, console.log("[Car/Truck] Make dropdown found by aria-controls at attempt", t + 1, "Element:", n);
                            break
                        }
                        let i = e.closest("form") || e.parentElement?.parentElement;
                        if (i) {
                            let e = i.querySelector('[role="listbox"], [role="menu"]');
                            if (e) {
                                let r = e.querySelectorAll("span").length > 0;
                                if (r) {
                                    n = e, o = !0, console.log("[Car/Truck] Make dropdown found near label at attempt", t + 1, "Element:", n);
                                    break
                                }
                            }
                        }
                        if (!n) {
                            let e = document.querySelector('[role="listbox"], [role="menu"]');
                            if (e) {
                                n = e, o = !0, console.warn("[Car/Truck] Found generic dropdown (may be wrong one) at attempt", t + 1, "Element:", n);
                                break
                            }
                        }
                        4 === t && console.log("[Car/Truck] Still waiting for Make dropdown (attempt 5/10)...")
                    }
                    if (o || console.warn("[Car/Truck] Make dropdown may not have opened, continuing anyway..."), n) {
                        let e = n.querySelectorAll("span"),
                            t = Array.from(e).map(e => e.textContent?.trim());
                        console.log("[Car/Truck] Available Make options in dropdown:", t.slice(0, 20))
                    }
                    let i = null;
                    if (n) {
                        let e = n.querySelectorAll("span");
                        (i = Array.from(e).find(e => e instanceof HTMLElement && e.textContent?.trim() === r)) || (console.log("[Car/Truck] Exact match not found, trying case-insensitive search..."), i = Array.from(e).find(e => e instanceof HTMLElement && e.textContent?.trim().toLowerCase() === r.toLowerCase())), i || (console.log("[Car/Truck] Case-insensitive match not found, trying partial match..."), i = Array.from(e).find(e => e instanceof HTMLElement && e.textContent?.trim().toLowerCase().replace(/\s+/g, "") === r.toLowerCase().replace(/\s+/g, ""))), console.log("[Car/Truck] First search for Make option in dropdown:", i ? "FOUND" : "NOT FOUND", r, i ? `(Found: "${i.textContent?.trim()}")` : "")
                    }
                    if (!i) {
                        if (console.log("[Car/Truck] Make option not found in dropdown, searching entire document..."), !(i = C("span", r))) {
                            let e = document.querySelectorAll("span");
                            i = Array.from(e).find(e => e instanceof HTMLElement && e.textContent?.trim().toLowerCase() === r.toLowerCase())
                        }
                        console.log("[Car/Truck] Search in entire document:", i ? "FOUND" : "NOT FOUND", r, i ? `(Found: "${i.textContent?.trim()}")` : "")
                    }
                    if (!i) {
                        if (console.log("[Car/Truck] Make option not found, waiting 0.3s and retrying..."), await O(.3), n) {
                            let e = n.querySelectorAll("span");
                            (i = Array.from(e).find(e => e instanceof HTMLElement && e.textContent?.trim() === r)) || (i = Array.from(e).find(e => e instanceof HTMLElement && e.textContent?.trim().toLowerCase() === r.toLowerCase()))
                        }
                        i || (i = C("span", r)), console.log("[Car/Truck] Second search for Make option:", i ? "FOUND" : "NOT FOUND", r, i ? `(Found: "${i.textContent?.trim()}")` : "")
                    }
                    if (!i) {
                        // Common miss: the dropdown didn't actually open. Reopen it and try once more before any fallback.
                        console.warn("[Car/Truck] Make option not found — reopening the dropdown and retrying:", r);
                        try { document.body.click(), await O(.2), await (0, c.humanClick)(e), await O(.6) } catch (xe) {}
                        let ac = e.getAttribute("aria-controls"),
                            dd = ac ? document.getElementById(ac) : null;
                        dd || (dd = document.querySelector('[role="listbox"],[role="menu"]'));
                        let sc = Array.from((dd || document).querySelectorAll("span"));
                        i = sc.find(x => x instanceof HTMLElement && x.textContent?.trim() === r) || sc.find(x => x instanceof HTMLElement && x.textContent?.trim().toLowerCase() === r.toLowerCase()) || sc.find(x => x instanceof HTMLElement && x.textContent?.trim().toLowerCase().replace(/\s+/g, "") === r.toLowerCase().replace(/\s+/g, "")), console.log("[Car/Truck] Reopen retry for Make:", i ? "FOUND" : "STILL NOT FOUND", r)
                    }
                    if (i) console.log("[Car/Truck] Make option found, clicking:", r, "Element:", i, "Text:", i.textContent), await (0, c.humanClick)(i), await O(.3), console.log("[Car/Truck] Clicked Make option, waiting for selection to register...");
                    else {
                        console.warn(`[Car/Truck] Make option '${r}' not found, trying fallback 'Toyota'`);
                        let e2 = C("span", "Toyota");
                        if (e2) console.log("[Car/Truck] Fallback Make 'Toyota' found, clicking:", e2.textContent), await (0, c.humanClick)(e2), await O(.3);
                        else throw console.error("[Car/Truck] Neither target nor fallback Make option found!"), Error("Neither target nor fallback Make option found")
                    }
                    await (0, c.waitUserDelay)(), console.log("[Car/Truck] Make selection completed successfully"), console.log("=== [Car/Truck] Make Selection Complete ===")
                } catch (e) {
                    console.error("[Car/Truck] Error selecting Make:", e instanceof Error ? e.message : e, e), console.error("[Car/Truck] Stack trace:", e instanceof Error ? e.stack : "N/A")
                }
                try {
                    let e = C("label", "Vehicle condition");
                    await (0, c.humanClick)(e), await O(.3);
                    let t = C("span", "Excellent");
                    await (0, c.humanClick)(t), await (0, c.waitUserDelay)()
                } catch (e) {
                    console.error("[Car/Truck] Error selecting vehicle condition:", e)
                }
                try {
                    let e = C("label", "Mileage"),
                        t = "string" == typeof A ? A.replace(",", "") : A?.toString() || "0";
                    /new/i.test(String($ || "")) && (parseInt(t, 10) || 0) < 300 && (t = "300", console.log("[Marketplace] New vehicle — mileage floored to Facebook's 300 minimum"));
                    await E(e, k(t) || "0")
                } catch (e) {
                    console.error("[Car/Truck] Error entering mileage:", e)
                }
                {
                    // Never leave a colour empty: unknown/missing paint data gets
                    // a random sensible colour so the required field always fills.
                    let xkRand = e => e[Math.floor(Math.random() * e.length)],
                        xkE = xkFbColor(T) || xkRand(["Black", "White", "Silver", "Grey", "Blue"]),
                        xkI = xkFbColor(_) || xkRand(["Black", "Grey", "Tan"]);
                    N.exterior_color = xkE, N.interior_color = xkI
                }
                console.log("=== [Car/Truck] Starting Exterior Color Selection ==="), console.log("[Car/Truck] Target exterior color:", N?.exterior_color || "Black"), console.log("[Car/Truck] Full vehicleAttributes:", JSON.stringify(N, null, 2));
                try {
                    console.log("[Car/Truck] Searching for 'Exterior color' label...");
                    let e = C("label", "Exterior colour") || C("label", "Exterior color");
                    if (!e) throw console.error("[Car/Truck] Exterior color label not found"), console.error("[Car/Truck] Available labels on page:", Array.from(document.querySelectorAll("label")).map(e => e.textContent)), Error("Exterior color label element not found");
                    console.log("[Car/Truck] Exterior color label found:", e.textContent, "Element:", e), console.log("[Car/Truck] Clicking exterior color label, target color:", N?.exterior_color || "Black"), console.log("[Car/Truck] Closing any open dropdowns before opening exterior color...");
                    let t = document.querySelectorAll('[aria-expanded="true"][role="combobox"]');
                    if (t.length > 0) {
                        console.log("[Car/Truck] Found", t.length, "open dropdown(s), closing them...");
                        let e = document.body;
                        e && (e.click(), await O(.2))
                    }
                    await (0, c.humanClick)(e), console.log("[Car/Truck] Clicked exterior color label, waiting for dropdown...");
                    let r = !1,
                        o = null,
                        n = null;
                    for (let t = 0; t < 10; t++) {
                        await O(.2);
                        let a = "true" === e.getAttribute("aria-expanded");
                        if (a && !n && (n = e.getAttribute("aria-controls"), console.log("[Car/Truck] Exterior color label expanded, aria-controls:", n)), n && (o = document.getElementById(n))) {
                            r = !0, console.log("[Car/Truck] Exterior color dropdown found by aria-controls at attempt", t + 1, "Element:", o);
                            break
                        }
                        let i = e.closest("form") || e.parentElement?.parentElement;
                        if (i) {
                            let e = i.querySelector('[role="listbox"], [role="menu"]');
                            if (e) {
                                let n = e.querySelectorAll("span").length > 0;
                                if (n) {
                                    o = e, r = !0, console.log("[Car/Truck] Exterior color dropdown found near label at attempt", t + 1, "Element:", o);
                                    break
                                }
                            }
                        }
                        if (!o) {
                            let e = document.querySelector('[role="listbox"], [role="menu"]');
                            if (e) {
                                o = e, r = !0, console.warn("[Car/Truck] Found generic dropdown (may be wrong one) at attempt", t + 1, "Element:", o);
                                break
                            }
                        }
                        4 === t && console.log("[Car/Truck] Still waiting for exterior color dropdown (attempt 5/10)...")
                    }
                    r || (console.warn("[Car/Truck] Exterior color dropdown may not have opened, continuing anyway..."), console.warn("[Car/Truck] Available dropdowns on page:", Array.from(document.querySelectorAll('[role="listbox"], [role="menu"]')).length));
                    let a = N?.exterior_color || "Black";
                    if (console.log("[Car/Truck] Looking for exterior color option with text:", a), o) {
                        let e = o.querySelectorAll("span"),
                            t = Array.from(e).map(e => e.textContent?.trim());
                        console.log("[Car/Truck] Available exterior color options in dropdown:", t)
                    }
                    let i = null;
                    if (o) {
                        let e = o.querySelectorAll("span");
                        i = Array.from(e).find(e => e instanceof HTMLElement && (e.textContent?.trim() === a || e.textContent?.trim() === xkColorTwin(a))), console.log("[Car/Truck] First search for exterior color option in dropdown:", i ? "FOUND" : "NOT FOUND", a)
                    }
                    if (i || (console.log("[Car/Truck] Exterior color option not found in dropdown, searching entire document..."), i = C("span", a) || C("span", xkColorTwin(a)), console.log("[Car/Truck] Search in entire document:", i ? "FOUND" : "NOT FOUND", a)), !i) {
                        if (console.log("[Car/Truck] Exterior color option not found, waiting 0.3s and retrying..."), await O(.3), o) {
                            let e = o.querySelectorAll("span");
                            i = Array.from(e).find(e => e instanceof HTMLElement && (e.textContent?.trim() === a || e.textContent?.trim() === xkColorTwin(a)))
                        }
                        i || (i = C("span", a) || C("span", xkColorTwin(a))), console.log("[Car/Truck] Second search for exterior color option:", i ? "FOUND" : "NOT FOUND", a)
                    }
                    if (i) console.log("[Car/Truck] Exterior color option found, clicking:", a, "Element:", i, "Text:", i.textContent), await (0, c.humanClick)(i), await O(.3), console.log("[Car/Truck] Clicked exterior color option, waiting for selection to register...");
                    else {
                        console.warn(`[Car/Truck] Exterior color option '${a}' not found after retry, trying fallback 'Black'`);
                        let e = C("span", "Black");
                        if (e) console.log("[Car/Truck] Fallback exterior color 'Black' found, clicking:", e.textContent), await (0, c.humanClick)(e), await O(.3);
                        else throw console.error("[Car/Truck] Neither target nor fallback exterior color option found!"), Error("Neither target nor fallback exterior color option found")
                    }
                    await (0, c.waitUserDelay)(), console.log("[Car/Truck] Exterior color selection completed successfully"), console.log("=== [Car/Truck] Exterior Color Selection Complete ===")
                } catch (e) {
                    console.error("[Car/Truck] Error selecting exterior color:", e instanceof Error ? e.message : e, e), console.error("[Car/Truck] Stack trace:", e instanceof Error ? e.stack : "N/A")
                }
                try {
                    let e = C("label", "Body style");
                    await (0, c.humanClick)(e), await O(.3);
                    // Prefer an option inside the OPEN dropdown so we never click
                    // a stray matching span elsewhere on the page.
                    let xkOpt = e => {
                            let t = document.querySelector('[role="listbox"], [role="menu"]');
                            if (t) {
                                let r = Array.from(t.querySelectorAll("span")).find(t => t.textContent?.trim() === e);
                                if (r) return r
                            }
                            return C("span", e)
                        },
                        xkBS = String(M || "").toLowerCase(),
                        xkCands = /truck|pickup/.test(xkBS) ? ["Truck", "Pickup truck", "Pickup"] :
                        /suv|sport ut|crossover|utility/.test(xkBS) ? ["SUV"] :
                        /convertible|cabriolet|roadster/.test(xkBS) ? ["Convertible"] :
                        /coupe/.test(xkBS) ? ["Coupe"] :
                        /hatch/.test(xkBS) ? ["Hatchback"] :
                        /wagon|estate/.test(xkBS) ? ["Estate", "Wagon"] :
                        /minivan|mini-van/.test(xkBS) ? ["Minivan", "Van"] :
                        /van/.test(xkBS) ? ["Van"] :
                        /sedan|saloon|4dr|4-door/.test(xkBS) ? ["Saloon", "Sedan"] : [];
                    let t = null;
                    for (let xkC of xkCands)
                        if (t = xkOpt(xkC)) break;
                    t || (t = xkOpt("Other")), console.log("[Car/Truck] Body style option clicked:", t && t.innerText, "(from:", M, ")");
                    t && await (0, c.humanClick)(t);
                    await (0, c.waitUserDelay)()
                } catch (e) {
                    console.error("[Car/Truck] Error selecting body style:", e)
                }
                console.log("[Car/Truck] Fuel type intentionally left empty (Facebook allows it).");
                console.log("=== [Car/Truck] Starting Interior Color Selection ==="), console.log("[Car/Truck] Target interior color:", N?.interior_color || "Black"), console.log("[Car/Truck] Full vehicleAttributes at interior color step:", JSON.stringify(N, null, 2));
                try {
                    console.log("[Car/Truck] Searching for 'Interior color' label...");
                    let e = C("label", "Interior colour") || C("label", "Interior color");
                    if (!e) throw console.error("[Car/Truck] Interior color label not found"), console.error("[Car/Truck] Available labels on page:", Array.from(document.querySelectorAll("label")).map(e => e.textContent)), Error("Interior color label element not found");
                    console.log("[Car/Truck] Interior color label found:", e.textContent, "Element:", e), console.log("[Car/Truck] Clicking interior color label, target color:", N?.interior_color || "Black"), console.log("[Car/Truck] Closing any open dropdowns before opening interior color...");
                    let t = document.querySelectorAll('[aria-expanded="true"][role="combobox"]');
                    if (t.length > 0) {
                        console.log("[Car/Truck] Found", t.length, "open dropdown(s), closing them...");
                        let e = document.body;
                        e && (e.click(), await O(.2))
                    }
                    await (0, c.humanClick)(e), console.log("[Car/Truck] Clicked interior color label, waiting for dropdown...");
                    let r = !1,
                        o = null,
                        n = null;
                    for (let t = 0; t < 10; t++) {
                        await O(.2);
                        let a = "true" === e.getAttribute("aria-expanded");
                        if (a && !n && (n = e.getAttribute("aria-controls"), console.log("[Car/Truck] Interior color label expanded, aria-controls:", n)), n && (o = document.getElementById(n))) {
                            r = !0, console.log("[Car/Truck] Interior color dropdown found by aria-controls at attempt", t + 1, "Element:", o);
                            break
                        }
                        let i = e.closest("form") || e.parentElement?.parentElement;
                        if (i) {
                            let e = i.querySelector('[role="listbox"], [role="menu"]');
                            if (e) {
                                let n = e.querySelectorAll("span").length > 0;
                                if (n) {
                                    o = e, r = !0, console.log("[Car/Truck] Interior color dropdown found near label at attempt", t + 1, "Element:", o);
                                    break
                                }
                            }
                        }
                        if (!o) {
                            let e = document.querySelector('[role="listbox"], [role="menu"]');
                            if (e) {
                                o = e, r = !0, console.warn("[Car/Truck] Found generic dropdown (may be wrong one) at attempt", t + 1, "Element:", o);
                                break
                            }
                        }
                        4 === t && console.log("[Car/Truck] Still waiting for interior color dropdown (attempt 5/10)...")
                    }
                    r || (console.warn("[Car/Truck] Interior color dropdown may not have opened, continuing anyway..."), console.warn("[Car/Truck] Available dropdowns on page:", Array.from(document.querySelectorAll('[role="listbox"], [role="menu"]')).length), console.warn("[Car/Truck] Elements with aria-expanded:", Array.from(document.querySelectorAll("[aria-expanded]")).map(e => ({
                        expanded: e.getAttribute("aria-expanded"),
                        text: e.textContent?.substring(0, 50)
                    }))));
                    let a = N?.interior_color || "Black";
                    if (console.log("[Car/Truck] Looking for interior color option with text:", a), o) {
                        let e = o.querySelectorAll("span"),
                            t = Array.from(e).map(e => e.textContent?.trim());
                        console.log("[Car/Truck] Available interior color options in dropdown:", t), console.log("[Car/Truck] Total interior color options found:", t.length)
                    } else {
                        console.warn("[Car/Truck] No dropdown element found, searching entire document for color options...");
                        let e = document.querySelectorAll("span"),
                            t = Array.from(e).filter(e => {
                                let t = e.textContent?.trim() || "";
                                return ["Black", "White", "Silver", "Gray", "Red", "Blue", "Green", "Brown", "Gold", "Purple", "Pink", "Orange"].some(e => t.toLowerCase().includes(e.toLowerCase()))
                            }).map(e => e.textContent?.trim());
                        console.log("[Car/Truck] Color-like spans found in document:", t.slice(0, 20))
                    }
                    let i = null;
                    if (o) {
                        let e = o.querySelectorAll("span");
                        i = Array.from(e).find(e => e instanceof HTMLElement && (e.textContent?.trim() === a || e.textContent?.trim() === xkColorTwin(a))), console.log("[Car/Truck] First search for interior color option in dropdown:", i ? "FOUND" : "NOT FOUND", a), i && console.log("[Car/Truck] Found interior color option element:", i, "Text:", i.textContent, "Parent:", i.parentElement)
                    }
                    if (i || (console.log("[Car/Truck] Interior color option not found in dropdown, searching entire document..."), i = C("span", a) || C("span", xkColorTwin(a)), console.log("[Car/Truck] Search in entire document:", i ? "FOUND" : "NOT FOUND", a)), !i) {
                        if (console.log("[Car/Truck] Interior color option not found, waiting 0.3s and retrying..."), await O(.3), o) {
                            let e = o.querySelectorAll("span");
                            i = Array.from(e).find(e => e instanceof HTMLElement && (e.textContent?.trim() === a || e.textContent?.trim() === xkColorTwin(a)))
                        }
                        i || (i = C("span", a) || C("span", xkColorTwin(a))), console.log("[Car/Truck] Second search for interior color option:", i ? "FOUND" : "NOT FOUND", a), i && console.log("[Car/Truck] Found interior color option on retry:", i.textContent)
                    }
                    if (i) {
                        console.log("[Car/Truck] Interior color option found, clicking:", a, "Element:", i, "Text:", i.textContent, "Is visible:", "none" !== window.getComputedStyle(i).display), await (0, c.humanClick)(i), await O(.3), console.log("[Car/Truck] Clicked interior color option, waiting for selection to register..."), await O(.2);
                        let t = e.textContent || "";
                        console.log("[Car/Truck] Interior color label text after selection:", t)
                    } else {
                        console.warn(`[Car/Truck] Interior color option '${a}' not found after retry, trying fallback 'Black'`);
                        let e = C("span", "Black");
                        if (e) console.log("[Car/Truck] Fallback interior color 'Black' found, clicking:", e.textContent), await (0, c.humanClick)(e), await O(.3);
                        else throw console.error("[Car/Truck] Neither target nor fallback interior color option found!"), console.error("[Car/Truck] All span elements with 'Black' text:", Array.from(document.querySelectorAll("span")).filter(e => e.textContent?.trim() === "Black").map(e => ({
                            text: e.textContent,
                            parent: e.parentElement?.tagName,
                            visible: "none" !== window.getComputedStyle(e).display
                        }))), Error("Neither target nor fallback interior color option found")
                    }
                    await (0, c.waitUserDelay)(), console.log("[Car/Truck] Interior color selection completed successfully"), console.log("=== [Car/Truck] Interior Color Selection Complete ===")
                } catch (e) {
                    console.error("[Car/Truck] Error selecting interior color:", e instanceof Error ? e.message : e, e), console.error("[Car/Truck] Stack trace:", e instanceof Error ? e.stack : "N/A")
                }
                W = `${p} ${L}`
            } else if ("Motorcycle" === r) {
                try {
                    let e = await (0, s.extractAttributesFromDescription)(q);
                    e && (N = {
                        body_style: e.body_style || N.body_style,
                        exterior_color: e.exterior_color || N.exterior_color,
                        interior_color: e.interior_color || N.interior_color,
                        fuel_type: e.fuel_type || N.fuel_type
                    })
                } catch (e) {
                    console.error("[Motorcycle] Error extracting AI attributes:", e)
                }
                try {
                    let e = C("label", "Make");
                    await (0, c.humanClick)(e), await O(.3);
                    let t = "";
                    try {
                        t = ["BMW", "KTM", "MV Agusta", "CFMoto"].includes(d) ? d : d?.split("-").map(e => e.charAt(0).toUpperCase() + e.slice(1).toLowerCase()).join("-")
                    } catch (e) {
                        console.error("[Motorcycle] Error processing Make:", e), t = d
                    }
                    let r = C("span", t || "Other");
                    if (r) await (0, c.humanClick)(r);
                    else {
                        console.warn("[Motorcycle] Make option not found, trying fallback 'Other'");
                        let e = C("span", "Other");
                        e && await (0, c.humanClick)(e)
                    }
                    await (0, c.waitUserDelay)()
                } catch (e) {
                    console.error("[Motorcycle] Error selecting Make:", e)
                }
                try {
                    let e = C("label", "Exterior colour") || C("label", "Exterior color");
                    await (0, c.humanClick)(e), await O(.3);
                    let t = C("span", xkFbColor(T) || N?.exterior_color || "Black");
                    if (t) await (0, c.humanClick)(t);
                    else {
                        console.warn("[Motorcycle] Exterior color option not found, trying fallback 'Black'");
                        let e = C("span", "Black");
                        e && await (0, c.humanClick)(e)
                    }
                    await (0, c.waitUserDelay)()
                } catch (e) {
                    console.error("[Motorcycle] Error selecting exterior color:", e)
                }
                console.log("[Motorcycle] Fuel type intentionally left empty (Facebook allows it).");
                try {
                    let e = C("label", "Mileage"),
                        t = "string" == typeof A ? A.replace(",", "") : A?.toString() || "0";
                    /new/i.test(String($ || "")) && (parseInt(t, 10) || 0) < 300 && (t = "300", console.log("[Marketplace] New vehicle — mileage floored to Facebook's 300 minimum"));
                    await E(e, k(t) || "0")
                } catch (e) {
                    console.error("[Motorcycle] Error entering mileage:", e)
                }
                W = `${p} ${L}`
            } else {
                try {
                    let e = C("label", "Make");
                    await E(e, k(d) || "n/a")
                } catch (e) {
                    console.error("[Other] Error entering Make:", e)
                }
                W = `${p} ${L} ${A||0} ${o}`
            }
            console.log("=== [Marketplace] Starting Model Entry ==="), console.log("[Marketplace] Model text to enter:", W);
            try {
                console.log("[Marketplace] Closing any open dropdowns before entering Model...");
                let e = document.querySelectorAll('[aria-expanded="true"][role="combobox"]');
                if (e.length > 0) {
                    console.log("[Marketplace] Found", e.length, "open dropdown(s), closing them...");
                    let t = document.body;
                    t && (t.click(), await O(.3))
                }
                let t = C("label", "Model");
                if (!t) throw console.error("[Marketplace] Model label not found"), Error("Model label element not found");
                console.log("[Marketplace] Model label found:", t.textContent, "Element:", t), await E(t, k(W) || "n/a"), console.log("[Marketplace] Model entry completed successfully"), console.log("=== [Marketplace] Model Entry Complete ===")
            } catch (e) {
                console.error("[Marketplace] Error entering Model:", e instanceof Error ? e.message : e, e)
            }
            try {
                let e = C("label", "Price");
                await E(e, k(f) || "n/a")
            } catch (e) {
                console.error("Error entering Price:", e)
            }
            try {
                let e = C("label", "Description"),
                    t = u ? `${R}
Stock Number: ${y}` : R;
                U && "string" == typeof U && "" !== U.trim() && (t = t.trimEnd() + "\n\n" + U.trim(), console.log("[Marketplace] Appended HardcodedDescription to final description")), await E(e, k(t) || "n/a")
            } catch (e) {
                console.error("Error entering Description:", e)
            }
            try {
                let e = Array.isArray(x) ? x.slice(0, 20) : [];
                await (0, i.uploadImagesToFacebook)(e)
            } catch (e) {
                console.error("Error uploading images:", e)
            }
            // Optional hands-off auto-publish (opt-in via the panel's "Auto-publish" toggle).
            try {
                let ap = await (0, a.default).storage.local.get("xkAutoPublish"),
                    on = ap && (!0 === ap.xkAutoPublish || "true" === ap.xkAutoPublish);
                if (on) {
                    await O(1.5);
                    let vis = b => b instanceof HTMLElement && null !== b.offsetParent,
                        enabled = b => "true" !== b.getAttribute("aria-disabled") && !0 !== b.disabled && "true" !== b.closest?.('[aria-disabled="true"]')?.getAttribute?.("aria-disabled"),
                        findBtn = (txt, needEnabled) => Array.from(document.querySelectorAll('div[role="button"],button')).find(b => { if (!vis(b)) return !1; let s = (b.innerText || b.textContent || "").trim().toLowerCase(); return s === txt && (!needEnabled || enabled(b)) });
                    // Photos are still uploading (the blue bars) — Next/Publish stay DISABLED until they finish.
                    // Each step: wait for an ENABLED Publish (preferred) or Next, then act. Up to ~90s for big photo sets.
                    for (let step = 0; step < 6; step++) {
                        let hit = null;
                        for (let i = 0; i < 180 && !hit; i++) {
                            let p = findBtn("publish", !0);
                            if (p) { hit = { el: p, kind: "publish" }; break }
                            let nx = findBtn("next", !0);
                            if (nx) { hit = { el: nx, kind: "next" }; break }
                            await O(.5)
                        }
                        if (!hit) { console.warn("[Marketplace] Auto-publish: Next/Publish stayed disabled (photos may still be uploading) — publish this one manually."); break }
                        if ("publish" === hit.kind) { console.log("[Marketplace] Auto-publish: clicking Publish"), await (0, c.humanClick)(hit.el), await O(3); try { chrome.runtime.sendMessage({ message: "fbPostFilled", vin: e && (e.VIN || e.vin) || "", published: !0 }) } catch (xe) {} await O(.4); try { chrome.runtime.sendMessage({ message: "xkClosePostTab" }) } catch (xe) {} break }
                        console.log("[Marketplace] Auto-publish: clicking Next (step " + (step + 1) + ")"), await (0, c.humanClick)(hit.el), await O(1.8)
                    }
                }
            } catch (e) {
                console.error("[Marketplace] Auto-publish error:", e)
            }
        }
        async function I(e, t) {
            let r = "",
                o = await $(e, t);
            o = o.replaceAll("title:", "description").replaceAll("title", "description").replaceAll("Title:", "description").replaceAll("Title", "description").replaceAll("TITLE", "description");
            let n = await (0, a.default).storage.local.get("password"),
                i = n.password?.replace(/\"/g, "") || "",
                l = {
                    api_key: i,
                    system_prompt: "You are a professional car description writer, generate concise and sales-focused descriptions",
                    user_prompt: o,
                    model: "gpt-4o-mini"
                };
            try {
                let e = await fetch("https://sag.gemquery.com/api/v1/generate-text", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify(l)
                    }),
                    t = await e.json();
                t.success ? r = t.text_response.trim() : console.error("Failed to generate AI description:", t.error)
            } catch (e) {
                console.error("Error during API call:", e)
            }
            return r
        }

        function O(e) {
            return new Promise(t => setTimeout(t, 1e3 * e))
        }

        function F(e) {
            return {
                emoji: e?.emoji?.replace(/\"/g, ""),
                imageBlog: e?.imageBlog,
                isAuthenticated: e?.isAuthenticated === "true",
                mileUnit: e?.mileUnit?.replace(/\"/g, ""),
                password: e?.password?.replace(/\"/g, ""),
                shouldAddStockNumber: e?.shouldAddStockNumber === "true",
                vehicleCategory: (t => t && "Other" !== t ? t : "Car/Truck")(e?.vehicleCategory?.replace(/\"/g, "")),
                description: e?.description?.replace(/\"/g, ""),
                whereToPost: e?.whereToPost?.replace(/\"/g, ""),
                isAiDescription: e?.isAiDescription === "true"
            }
        }
        async function $(e, t) {
            try {
                let {
                    shouldAddInstructions: r
                } = await (0, a.default).storage.local.get("shouldAddInstructions"), o = `Here is the vehicle information:
${e} Mileage: ${t}

Please write a simple, magazine-style article description for this vehicle. **Start with the year, make, and model**, then state the current mileage. **Highlight key features** that make this vehicle stand out. Keep it concise and engaging. Do not use any special characters or include the dealership name. Aim for about 80\u2013120 words.`;
                if ("true" === r) {
                    let {
                        description: e
                    } = await (0, a.default).storage.local.get("description"), t = e?.replace(/"/g, "");
                    if (t) {
                        let e = `${t}

${o}`;
                        return e
                    }
                }
                return o
            } catch (e) {
                return console.error("Error in preparePromptForOpenAI:", e), "Error generating prompt"
            }
        }

        function U(e, t, r) {
            let o = new Map;
            t?.forEach(e => {
                e?.VIN && o.set(e.VIN, e)
            });
            let n = e => {
                    if (!e) return e;
                    let t = e.replace(/[^\d.-]/g, ""),
                        r = parseFloat(t);
                    return isNaN(r) ? e : `$${r.toLocaleString()}`
                },
                a = (e, t) => {
                    if (!t) return {
                        priceChanged: !1,
                        newPrice: null
                    };
                    let r = e?.price || e?.Price,
                        o = t?.Price;
                    if (!r || !o) return {
                        priceChanged: !1,
                        newPrice: null
                    };
                    let a = e => "string" != typeof e ? e : e.replace(/[^\d.-]/g, ""),
                        i = a(r),
                        l = a(o),
                        s = i !== l;
                    return {
                        priceChanged: s,
                        newPrice: s ? n(o) : null,
                        oldPrice: s ? n(r) : null
                    }
                };
            return r ? e?.map(e => {
                let t = o.get(e?.vin),
                    r = a(e, t);
                return {
                    ...e,
                    present: o.has(e?.vin),
                    ...r
                }
            })?.filter(e => !o.has(e?.vin)) : e?.map(e => {
                let t = o.get(e?.vin),
                    r = a(e, t);
                return {
                    ...e,
                    present: o.has(e?.vin),
                    ...r
                }
            })
        }

        function D(e, t) {
            return t?.some(t => t?.vin === e)
        }
    }, {
        "webextension-polyfill": "hkciQ",
        "~imagesUpload/images": "dF3FE",
        "~utils/ai": "1AesJ",
        "~utils/aiAttributes": "kmzlN",
        "~utils/humanInteraction": "9KUoU",
        "@parcel/transformer-js/src/esmodule-helpers.js": "cHUbl"
    }],
    hkciQ: [function(t, r, o) {
        var n;
        "undefined" != typeof globalThis ? globalThis : "undefined" != typeof self && self, n = function(e) {
            if (!(globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id)) throw Error("This script should only be loaded in a browser extension.");
            globalThis.browser && globalThis.browser.runtime && globalThis.browser.runtime.id ? e.exports = globalThis.browser : e.exports = (e => {
                let t = {
                    alarms: {
                        clear: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        clearAll: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        get: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        getAll: {
                            minArgs: 0,
                            maxArgs: 0
                        }
                    },
                    bookmarks: {
                        create: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        get: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getChildren: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getRecent: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getSubTree: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getTree: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        move: {
                            minArgs: 2,
                            maxArgs: 2
                        },
                        remove: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        removeTree: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        search: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        update: {
                            minArgs: 2,
                            maxArgs: 2
                        }
                    },
                    browserAction: {
                        disable: {
                            minArgs: 0,
                            maxArgs: 1,
                            fallbackToNoCallback: !0
                        },
                        enable: {
                            minArgs: 0,
                            maxArgs: 1,
                            fallbackToNoCallback: !0
                        },
                        getBadgeBackgroundColor: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getBadgeText: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getPopup: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getTitle: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        openPopup: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        setBadgeBackgroundColor: {
                            minArgs: 1,
                            maxArgs: 1,
                            fallbackToNoCallback: !0
                        },
                        setBadgeText: {
                            minArgs: 1,
                            maxArgs: 1,
                            fallbackToNoCallback: !0
                        },
                        setIcon: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        setPopup: {
                            minArgs: 1,
                            maxArgs: 1,
                            fallbackToNoCallback: !0
                        },
                        setTitle: {
                            minArgs: 1,
                            maxArgs: 1,
                            fallbackToNoCallback: !0
                        }
                    },
                    browsingData: {
                        remove: {
                            minArgs: 2,
                            maxArgs: 2
                        },
                        removeCache: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        removeCookies: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        removeDownloads: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        removeFormData: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        removeHistory: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        removeLocalStorage: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        removePasswords: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        removePluginData: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        settings: {
                            minArgs: 0,
                            maxArgs: 0
                        }
                    },
                    commands: {
                        getAll: {
                            minArgs: 0,
                            maxArgs: 0
                        }
                    },
                    contextMenus: {
                        remove: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        removeAll: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        update: {
                            minArgs: 2,
                            maxArgs: 2
                        }
                    },
                    cookies: {
                        get: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getAll: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getAllCookieStores: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        remove: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        set: {
                            minArgs: 1,
                            maxArgs: 1
                        }
                    },
                    devtools: {
                        inspectedWindow: {
                            eval: {
                                minArgs: 1,
                                maxArgs: 2,
                                singleCallbackArg: !1
                            }
                        },
                        panels: {
                            create: {
                                minArgs: 3,
                                maxArgs: 3,
                                singleCallbackArg: !0
                            },
                            elements: {
                                createSidebarPane: {
                                    minArgs: 1,
                                    maxArgs: 1
                                }
                            }
                        }
                    },
                    downloads: {
                        cancel: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        download: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        erase: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getFileIcon: {
                            minArgs: 1,
                            maxArgs: 2
                        },
                        open: {
                            minArgs: 1,
                            maxArgs: 1,
                            fallbackToNoCallback: !0
                        },
                        pause: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        removeFile: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        resume: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        search: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        show: {
                            minArgs: 1,
                            maxArgs: 1,
                            fallbackToNoCallback: !0
                        }
                    },
                    extension: {
                        isAllowedFileSchemeAccess: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        isAllowedIncognitoAccess: {
                            minArgs: 0,
                            maxArgs: 0
                        }
                    },
                    history: {
                        addUrl: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        deleteAll: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        deleteRange: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        deleteUrl: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getVisits: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        search: {
                            minArgs: 1,
                            maxArgs: 1
                        }
                    },
                    i18n: {
                        detectLanguage: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getAcceptLanguages: {
                            minArgs: 0,
                            maxArgs: 0
                        }
                    },
                    identity: {
                        launchWebAuthFlow: {
                            minArgs: 1,
                            maxArgs: 1
                        }
                    },
                    idle: {
                        queryState: {
                            minArgs: 1,
                            maxArgs: 1
                        }
                    },
                    management: {
                        get: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getAll: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        getSelf: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        setEnabled: {
                            minArgs: 2,
                            maxArgs: 2
                        },
                        uninstallSelf: {
                            minArgs: 0,
                            maxArgs: 1
                        }
                    },
                    notifications: {
                        clear: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        create: {
                            minArgs: 1,
                            maxArgs: 2
                        },
                        getAll: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        getPermissionLevel: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        update: {
                            minArgs: 2,
                            maxArgs: 2
                        }
                    },
                    pageAction: {
                        getPopup: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getTitle: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        hide: {
                            minArgs: 1,
                            maxArgs: 1,
                            fallbackToNoCallback: !0
                        },
                        setIcon: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        setPopup: {
                            minArgs: 1,
                            maxArgs: 1,
                            fallbackToNoCallback: !0
                        },
                        setTitle: {
                            minArgs: 1,
                            maxArgs: 1,
                            fallbackToNoCallback: !0
                        },
                        show: {
                            minArgs: 1,
                            maxArgs: 1,
                            fallbackToNoCallback: !0
                        }
                    },
                    permissions: {
                        contains: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getAll: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        remove: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        request: {
                            minArgs: 1,
                            maxArgs: 1
                        }
                    },
                    runtime: {
                        getBackgroundPage: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        getPlatformInfo: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        openOptionsPage: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        requestUpdateCheck: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        sendMessage: {
                            minArgs: 1,
                            maxArgs: 3
                        },
                        sendNativeMessage: {
                            minArgs: 2,
                            maxArgs: 2
                        },
                        setUninstallURL: {
                            minArgs: 1,
                            maxArgs: 1
                        }
                    },
                    sessions: {
                        getDevices: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        getRecentlyClosed: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        restore: {
                            minArgs: 0,
                            maxArgs: 1
                        }
                    },
                    storage: {
                        local: {
                            clear: {
                                minArgs: 0,
                                maxArgs: 0
                            },
                            get: {
                                minArgs: 0,
                                maxArgs: 1
                            },
                            getBytesInUse: {
                                minArgs: 0,
                                maxArgs: 1
                            },
                            remove: {
                                minArgs: 1,
                                maxArgs: 1
                            },
                            set: {
                                minArgs: 1,
                                maxArgs: 1
                            }
                        },
                        managed: {
                            get: {
                                minArgs: 0,
                                maxArgs: 1
                            },
                            getBytesInUse: {
                                minArgs: 0,
                                maxArgs: 1
                            }
                        },
                        sync: {
                            clear: {
                                minArgs: 0,
                                maxArgs: 0
                            },
                            get: {
                                minArgs: 0,
                                maxArgs: 1
                            },
                            getBytesInUse: {
                                minArgs: 0,
                                maxArgs: 1
                            },
                            remove: {
                                minArgs: 1,
                                maxArgs: 1
                            },
                            set: {
                                minArgs: 1,
                                maxArgs: 1
                            }
                        }
                    },
                    tabs: {
                        captureVisibleTab: {
                            minArgs: 0,
                            maxArgs: 2
                        },
                        create: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        detectLanguage: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        discard: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        duplicate: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        executeScript: {
                            minArgs: 1,
                            maxArgs: 2
                        },
                        get: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getCurrent: {
                            minArgs: 0,
                            maxArgs: 0
                        },
                        getZoom: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        getZoomSettings: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        goBack: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        goForward: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        highlight: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        insertCSS: {
                            minArgs: 1,
                            maxArgs: 2
                        },
                        move: {
                            minArgs: 2,
                            maxArgs: 2
                        },
                        query: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        reload: {
                            minArgs: 0,
                            maxArgs: 2
                        },
                        remove: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        removeCSS: {
                            minArgs: 1,
                            maxArgs: 2
                        },
                        sendMessage: {
                            minArgs: 2,
                            maxArgs: 3
                        },
                        setZoom: {
                            minArgs: 1,
                            maxArgs: 2
                        },
                        setZoomSettings: {
                            minArgs: 1,
                            maxArgs: 2
                        },
                        update: {
                            minArgs: 1,
                            maxArgs: 2
                        }
                    },
                    topSites: {
                        get: {
                            minArgs: 0,
                            maxArgs: 0
                        }
                    },
                    webNavigation: {
                        getAllFrames: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        getFrame: {
                            minArgs: 1,
                            maxArgs: 1
                        }
                    },
                    webRequest: {
                        handlerBehaviorChanged: {
                            minArgs: 0,
                            maxArgs: 0
                        }
                    },
                    windows: {
                        create: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        get: {
                            minArgs: 1,
                            maxArgs: 2
                        },
                        getAll: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        getCurrent: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        getLastFocused: {
                            minArgs: 0,
                            maxArgs: 1
                        },
                        remove: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        update: {
                            minArgs: 2,
                            maxArgs: 2
                        }
                    }
                };
                if (0 === Object.keys(t).length) throw Error("api-metadata.json has not been included in browser-polyfill");
                class r extends WeakMap {
                    constructor(e, t) {
                        super(t), this.createItem = e
                    }
                    get(e) {
                        return this.has(e) || this.set(e, this.createItem(e)), super.get(e)
                    }
                }
                let o = e => e && "object" == typeof e && "function" == typeof e.then,
                    n = (t, r) => (...o) => {
                        e.runtime.lastError ? t.reject(Error(e.runtime.lastError.message)) : r.singleCallbackArg || o.length <= 1 && !1 !== r.singleCallbackArg ? t.resolve(o[0]) : t.resolve(o)
                    },
                    a = e => 1 == e ? "argument" : "arguments",
                    i = (e, t) => function(r, ...o) {
                        if (o.length < t.minArgs) throw Error(`Expected at least ${t.minArgs} ${a(t.minArgs)} for ${e}(), got ${o.length}`);
                        if (o.length > t.maxArgs) throw Error(`Expected at most ${t.maxArgs} ${a(t.maxArgs)} for ${e}(), got ${o.length}`);
                        return new Promise((a, i) => {
                            if (t.fallbackToNoCallback) try {
                                r[e](...o, n({
                                    resolve: a,
                                    reject: i
                                }, t))
                            } catch (n) {
                                console.warn(`${e} API method doesn't seem to support the callback parameter, falling back to call it without a callback: `, n), r[e](...o), t.fallbackToNoCallback = !1, t.noCallback = !0, a()
                            } else t.noCallback ? (r[e](...o), a()) : r[e](...o, n({
                                resolve: a,
                                reject: i
                            }, t))
                        })
                    },
                    l = (e, t, r) => new Proxy(t, {
                        apply: (t, o, n) => r.call(o, e, ...n)
                    }),
                    s = Function.call.bind(Object.prototype.hasOwnProperty),
                    c = (e, t = {}, r = {}) => {
                        let o = Object.create(null),
                            n = Object.create(e);
                        return new Proxy(n, {
                            has: (t, r) => r in e || r in o,
                            get(n, a, u) {
                                if (a in o) return o[a];
                                if (!(a in e)) return;
                                let g = e[a];
                                if ("function" == typeof g) {
                                    if ("function" == typeof t[a]) g = l(e, e[a], t[a]);
                                    else if (s(r, a)) {
                                        let t = i(a, r[a]);
                                        g = l(e, e[a], t)
                                    } else g = g.bind(e)
                                } else if ("object" == typeof g && null !== g && (s(t, a) || s(r, a))) g = c(g, t[a], r[a]);
                                else {
                                    if (!s(r, "*")) return Object.defineProperty(o, a, {
                                        configurable: !0,
                                        enumerable: !0,
                                        get: () => e[a],
                                        set(t) {
                                            e[a] = t
                                        }
                                    }), g;
                                    g = c(g, t[a], r["*"])
                                }
                                return o[a] = g, g
                            },
                            set: (t, r, n, a) => (r in o ? o[r] = n : e[r] = n, !0),
                            defineProperty: (e, t, r) => Reflect.defineProperty(o, t, r),
                            deleteProperty: (e, t) => Reflect.deleteProperty(o, t)
                        })
                    },
                    u = e => ({
                        addListener(t, r, ...o) {
                            t.addListener(e.get(r), ...o)
                        },
                        hasListener: (t, r) => t.hasListener(e.get(r)),
                        removeListener(t, r) {
                            t.removeListener(e.get(r))
                        }
                    }),
                    g = new r(e => "function" != typeof e ? e : function(t) {
                        let r = c(t, {}, {
                            getContent: {
                                minArgs: 0,
                                maxArgs: 0
                            }
                        });
                        e(r)
                    }),
                    d = new r(e => "function" != typeof e ? e : function(t, r, n) {
                        let a, i, l = !1,
                            s = new Promise(e => {
                                a = function(t) {
                                    l = !0, e(t)
                                }
                            });
                        try {
                            i = e(t, r, a)
                        } catch (e) {
                            i = Promise.reject(e)
                        }
                        let c = !0 !== i && o(i);
                        return (!0 === i || !!c || !!l) && ((e => {
                            e.then(e => {
                                n(e)
                            }, e => {
                                n({
                                    __mozWebExtensionPolyfillReject__: !0,
                                    message: e && (e instanceof Error || "string" == typeof e.message) ? e.message : "An unexpected error occurred"
                                })
                            }).catch(e => {
                                console.error("Failed to send onMessage rejected reply", e)
                            })
                        })(c ? i : s), !0)
                    }),
                    p = ({
                        reject: t,
                        resolve: r
                    }, o) => {
                        e.runtime.lastError ? "The message port closed before a response was received." === e.runtime.lastError.message ? r() : t(Error(e.runtime.lastError.message)) : o && o.__mozWebExtensionPolyfillReject__ ? t(Error(o.message)) : r(o)
                    },
                    m = (e, t, r, ...o) => {
                        if (o.length < t.minArgs) throw Error(`Expected at least ${t.minArgs} ${a(t.minArgs)} for ${e}(), got ${o.length}`);
                        if (o.length > t.maxArgs) throw Error(`Expected at most ${t.maxArgs} ${a(t.maxArgs)} for ${e}(), got ${o.length}`);
                        return new Promise((e, t) => {
                            let n = p.bind(null, {
                                resolve: e,
                                reject: t
                            });
                            o.push(n), r.sendMessage(...o)
                        })
                    },
                    f = {
                        devtools: {
                            network: {
                                onRequestFinished: u(g)
                            }
                        },
                        runtime: {
                            onMessage: u(d),
                            onMessageExternal: u(d),
                            sendMessage: m.bind(null, "sendMessage", {
                                minArgs: 1,
                                maxArgs: 3
                            })
                        },
                        tabs: {
                            sendMessage: m.bind(null, "sendMessage", {
                                minArgs: 2,
                                maxArgs: 3
                            })
                        }
                    },
                    h = {
                        clear: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        get: {
                            minArgs: 1,
                            maxArgs: 1
                        },
                        set: {
                            minArgs: 1,
                            maxArgs: 1
                        }
                    };
                return t.privacy = {
                    network: {
                        "*": h
                    },
                    services: {
                        "*": h
                    },
                    websites: {
                        "*": h
                    }
                }, c(e, f, t)
            })(chrome)
        }, "function" == typeof e && e.amd ? e("webextension-polyfill", ["module"], n) : n(r)
    }, {}],
    dF3FE: [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        o.defineInteropFlag(r), o.export(r, "uploadImagesToFacebook", () => h);
        let n = (e, t) => Math.floor(e + Math.random() * (t - e + 1));

        function a(e) {
            return new Promise(t => setTimeout(t, e))
        }
        let i = 0;
        async function l(e) {
            try {
                let t = await s(e);
                if (t) return t
            } catch {}
            console.log("[Marketplace Upload] Direct fetch failed (CORS?), using background fallback...");
            try {
                return await c(e)
            } catch (t) {
                return console.warn("[Marketplace Upload] Background fallback also failed:", e?.substring(0, 60), t), ""
            }
        }
        async function s(e) {
            let t = new AbortController,
                r = setTimeout(() => t.abort(), 15e3),
                o = await fetch(e, {
                    signal: t.signal,
                    headers: {
                        Accept: "image/webp,image/avif,image/*,*/*;q=0.8",
                        "Cache-Control": "no-cache"
                    }
                });
            if (clearTimeout(r), !o.ok) throw Error(`HTTP ${o.status}`);
            let n = await o.blob();
            return n.size > 8388608 ? "" : await new Promise((e, t) => {
                let r = new FileReader;
                r.onloadend = () => e(r.result), r.onerror = t, r.readAsDataURL(n)
            })
        }
        async function c(e) {
            let t = `${Date.now()}_${++i}`;
            await chrome.storage.local.set({
                _imgReq: {
                    id: t,
                    url: e
                }
            });
            let r = `_imgRes_${t}`,
                o = Date.now();
            for (; Date.now() - o < 25e3;) {
                await a(300);
                let e = await chrome.storage.local.get(r);
                if (void 0 !== e[r]) {
                    let t = e[r];
                    return chrome.storage.local.remove(r), t || ""
                }
            }
            throw Error("Background fetch timed out")
        }

        function u() {
            let e = document.querySelector('[role="dialog"] form')?.querySelector('input[type="file"]');
            if (e) return e;
            let t = document.querySelectorAll('input[type="file"]');
            for (let e of t) {
                let t = window.getComputedStyle(e);
                if ("none" !== t.display && "hidden" !== t.visibility) return e
            }
            return t.length > 0 ? t[0] : null
        }

        function g() {
            return document.querySelectorAll('img[src^="blob:"], img[src^="data:"], div[data-visualcompletion="media-vc-image"]').length
        }
        async function d(e, t = 4e3) {
            let r = performance.now();
            for (; performance.now() - r < t;) {
                if (g() > e) return !0;
                await a(100)
            }
            return !1
        }
        let p = e => {
                let t = /^data:([^;,]+)[;,]/i.exec(e || "");
                return t?.[1]?.toLowerCase() || "image/jpeg"
            },
            m = e => e.includes("png") ? "png" : e.includes("webp") ? "webp" : e.includes("gif") ? "gif" : "jpg";

        function f(e, t) {
            let r = p(e),
                o = e.split(",")[1] || e,
                n = atob(o),
                a = [];
            for (let e = 0; e < n.length; e += 512) {
                let t = n.slice(e, e + 512),
                    r = new Uint8Array(t.length);
                for (let e = 0; e < t.length; e++) r[e] = t.charCodeAt(e);
                a.push(r.buffer)
            }
            return new File(a, t, {
                type: r,
                lastModified: Date.now()
            })
        }
        async function h(e) {
            if (!e || 0 === e.length) {
                console.log("[Marketplace Upload] No image URLs provided, skipping");
                return
            }
            let t = e.slice(0, 20);
            console.log(`[Marketplace Upload] Batch upload for ${t.length} images (parallel fetch + one drop)`);
            // 1) Download EVERYTHING in parallel.
            let w = await Promise.all(t.map(e => e && "string" == typeof e ? (e.startsWith("data:") ? Promise.resolve(e) : l(e).catch(() => "")) : Promise.resolve("")));
            let r = [];
            for (let e = 0; e < w.length; e++) {
                let o = w[e];
                if (o) try {
                    let t = p(o),
                        n = m(t),
                        a = f(o, `IMG_${String(e+1).padStart(2,"0")}.${n}`);
                    a.size > 0 && a.size <= 8388608 ? r.push(a) : console.warn(`[Marketplace Upload] Image ${e+1}: bad size, skipping`)
                } catch (t) {
                    console.warn(`[Marketplace Upload] Image ${e+1}: convert failed`, t)
                }
            }
            if (!r.length) {
                console.warn("[Marketplace Upload] No valid images to upload");
                return
            }
            // 2) One DataTransfer with EVERY file, dropped on the Add-photos zone
            //    \u2014 Facebook ingests the whole batch at once, like a real drag.
            let x = g(),
                v = new DataTransfer;
            r.forEach(e => v.items.add(e));
            let y = null,
                b = performance.now();
            for (; performance.now() - b < 8e3 && !y;) {
                for (let e of Array.from(document.querySelectorAll('[role="button"]')).filter(e => null !== e.offsetParent)) {
                    let t = (e.innerText || "").toLowerCase();
                    if (t.includes("add photo")) {
                        y = e.closest("div") || e;
                        break
                    }
                }
                y || await a(150)
            }
            let k = (e, t) => {
                try {
                    t.dispatchEvent(new DragEvent(e, {
                        bubbles: !0,
                        cancelable: !0,
                        dataTransfer: v
                    }))
                } catch (r) {}
            };
            if (y) {
                y.scrollIntoView({ block: "center" }), await a(200),
                k("dragenter", y), k("dragover", y), k("drop", y);
                let e = y.querySelector('[role="button"]');
                e && (await a(160), k("dragenter", e), k("dragover", e), k("drop", e)),
                await a(800)
            }
            // 3) Reinforce via the file input (all files at once) if nothing landed.
            if (g() <= x) {
                let e = u();
                if (e) try {
                    Object.defineProperty(e, "files", {
                        value: v.files,
                        writable: !1,
                        configurable: !0
                    }), e.dispatchEvent(new Event("input", {
                        bubbles: !0
                    })), e.dispatchEvent(new Event("change", {
                        bubbles: !0
                    })), await a(800)
                } catch (t) {
                    console.warn("[Marketplace Upload] file-input batch fallback failed:", t)
                }
            }
            // 4) Wait while previews stream in (extend deadline while progressing).
            let S = performance.now() + 15e3,
                T = g();
            for (; performance.now() < S;) {
                let e = g();
                if (e >= x + r.length) break;
                e > T && (T = e, S = performance.now() + 8e3), await a(250)
            }
            let A = g() - x;
            console.log(`[Marketplace Upload] Batch drop done \u2014 ${A}/${r.length} previews detected`);
            // 5) Last resort: old one-by-one flow if the batch drop didn't take.
            if (A < 1) {
                console.warn("[Marketplace Upload] Batch failed \u2014 falling back to per-file uploads");
                for (let e = 0; e < r.length; e++) {
                    let t = u();
                    if (!t) break;
                    let o = new DataTransfer;
                    o.items.add(r[e]);
                    let i = g();
                    t.value = "", t.files = o.files, t.dispatchEvent(new Event("change", {
                        bubbles: !0
                    })), await d(i), e < r.length - 1 && await a(n(250, 500))
                }
            }
            console.log(`[Marketplace Upload] Done \u2014 ${Math.max(A, 0)}/${r.length} via batch`)
        }
    }, {
        "@parcel/transformer-js/src/esmodule-helpers.js": "cHUbl"
    }],
    cHUbl: [function(e, t, r) {
        r.interopDefault = function(e) {
            return e && e.__esModule ? e : {
                default: e
            }
        }, r.defineInteropFlag = function(e) {
            Object.defineProperty(e, "__esModule", {
                value: !0
            })
        }, r.exportAll = function(e, t) {
            return Object.keys(e).forEach(function(r) {
                "default" === r || "__esModule" === r || t.hasOwnProperty(r) || Object.defineProperty(t, r, {
                    enumerable: !0,
                    get: function() {
                        return e[r]
                    }
                })
            }), t
        }, r.export = function(e, t, r) {
            Object.defineProperty(e, t, {
                enumerable: !0,
                get: r
            })
        }
    }, {}],
    "1AesJ": [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        o.defineInteropFlag(r), o.export(r, "AIDescription", () => l), o.export(r, "generateAIDescription", () => i);
        var n = e("./aiAttributes"),
            a = e("./helping");
        async function i(e) {
            try {
                let t, r;
                let o = await chrome.storage.local.get("description"),
                    n = o?.description || "";
                n = n.replace(/\"/g, "").trim();
                let i = n && n.length > 0;
                t = i ? `You are a vehicle listing writer for Facebook Marketplace.

CRITICAL: Follow the user's instructions EXACTLY. They override everything else.

USER INSTRUCTIONS:
${n}

VEHICLE DATA:
${e}

RULES:
- Follow user instructions FIRST
- If user says "use bullet points" \u2192 use bullet points
- If user mentions a salesman name \u2192 include that name
- Keep it clean and professional
- NO emojis unless requested

Write the description following user instructions.` : `You are a vehicle listing writer. Write a clean, professional description.

EXACT FORMAT TO FOLLOW:

[Year] [Make] [Model].

[One paragraph - 4-5 sentences. Include: mileage, color, price, condition, and one or two appealing features. Keep it professional but not overly salesy.]

Contact us for more information.

EXAMPLE OUTPUT:
2024 Toyota Camry SE.

This well-maintained vehicle has 25,000 miles and features a sleek Silver exterior with a comfortable Black interior. Powered by a reliable 2.5L engine, it delivers great fuel efficiency and a smooth ride. Priced at $24,500, this Camry is in excellent condition and ready for its next owner. Don't miss out on this great opportunity.

Contact us for more information.

RULES:
- First line: Year Make Model with a period
- Second section: ONE paragraph (4-5 sentences)
- Last line: Simple call to action
- NO bullet points
- Keep it professional but not over-the-top marketing
- NO repeating the same information twice
- Around 60-80 words for the paragraph
- Be factual with light appeal

VEHICLE DATA:
${e}

Write now.`;
                let l = await chrome.storage.local.get("password"),
                    s = l.password?.replace(/\"/g, "") || "";
                try {
                    r = await (0, a.fetchJson)("https://sag.gemquery.com/api/v1/generate-text", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            api_key: s,
                            system_prompt: t,
                            user_prompt: i ? "Write the description following my instructions." : "Write the description.",
                            model: "gpt-4o-mini",
                            max_tokens: 250
                        })
                    })
                } catch (e) {
                    return console.error("[AI] fetchJson error:", e), ""
                }
                if (!r || !r.success) return console.error("[AI] Failed to generate description:", r?.error || "Unknown error"), "";
                {
                    let e = r.text_response?.trim() || "";
                    return e
                }
            } catch (e) {
                return console.error("[AI] Error during API call:", e), ""
            }
        }
        async function l(e) {
            let t = await (0, n.extractAttributesFromDescription)(e);
            return t || ""
        }
    }, {
        "./aiAttributes": "kmzlN",
        "./helping": "eBThj",
        "@parcel/transformer-js/src/esmodule-helpers.js": "cHUbl"
    }],
    kmzlN: [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        async function n(e) {
            try {
                let t = await chrome.storage.local.get("password"),
                    r = t.password?.replace(/\"/g, "") || "",
                    o = ["Black", "Blue", "Brown", "Gold", "Green", "Gray", "Pink", "Purple", "Red", "Silver", "White"],
                    n = `
You are an expert vehicle classifier that extracts structured attributes from vehicle descriptions.
Return ONLY a valid JSON object in this exact format with proper quotes:

{
  "body_style": "Sedan",
  "exterior_color": "White", 
  "interior_color": "Black",
  "fuel_type": "Gasoline"
}

CRITICAL: All property names and string values MUST be wrapped in double quotes for valid JSON.

Allowed values:
- body_style: Sedan | Truck | SUV | Coupe | Convertible | Hatchback | Wagon | Minivan | Small Car | Other
- exterior_color: ${o.join(" | ")}
- interior_color: ${o.join(" | ")}
- fuel_type: Gasoline | Diesel | Electric | Hybrid

BODY STYLE CLASSIFICATION RULES (make educated guesses, avoid "Other"):
- Look for keywords: "SUV" \u2192 "SUV", "truck" \u2192 "Truck", "van" \u2192 "Minivan"
- "4-door sedan" \u2192 "Sedan", "2-door" \u2192 "Coupe", "hatchback" \u2192 "Hatchback"
- "wagon" or "estate" \u2192 "Wagon", "convertible" \u2192 "Convertible"
- "compact" or "small car" \u2192 "Small Car"
- If it mentions "4x4", "off-road", "high clearance" \u2192 likely "SUV" or "Truck"
- If it mentions "passenger capacity" or "seating" \u2192 likely "Minivan" or "SUV"
- Use context clues from vehicle model names (e.g., "F-150" \u2192 "Truck", "CR-V" \u2192 "SUV")
- ONLY use "Other" if you truly cannot determine the body style

FUEL TYPE CLASSIFICATION RULES:
- Look for: "electric", "EV", "battery" \u2192 "Electric"
- "hybrid", "HEV", "PHEV" \u2192 "Hybrid" 
- "diesel" \u2192 "Diesel"
- Any mention of "cylinders", "gasoline", "petrol", "gas", "V6", "V8", etc. \u2192 "Gasoline"
- Default to "Gasoline" if unclear

COLOR RULES:
- Always pick the closest allowed color (e.g., "Platinum White Pearl" \u2192 "White", "Maroon" \u2192 "Red").
- If interior color not mentioned, default to "Black"

IMPORTANT: Make educated guesses based on context. Only use fallback defaults if absolutely necessary.
Do not include any text outside the JSON.
Ensure all strings are properly quoted with double quotes.
`,
                    a = await fetch("https://sag.gemquery.com/api/v1/generate-text", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            api_key: r,
                            system_prompt: n,
                            user_prompt: e,
                            model: "gpt-4o-mini",
                            max_tokens: 200
                        })
                    }).then(e => e.json());
                if (a.success) try {
                    let e = a.text_response.trim();
                    e = e.replace(/(\w+):/g, '"$1":').replace(/:\s*([A-Za-z][A-Za-z\s]*[A-Za-z])\s*([,}])/g, ': "$1"$2').replace(/:\s*([A-Za-z][A-Za-z]*)\s*([,}])/g, ': "$1"$2');
                    let t = JSON.parse(e);
                    return t
                } catch (e) {
                    console.error("[UnifiedAI] JSON parse error:", e, a.text_response), console.error("[UnifiedAI] Attempted to clean response:", a.text_response.trim())
                } else console.error("[UnifiedAI] API error:", a.error)
            } catch (e) {
                console.error("[UnifiedAI] Error during API call:", e)
            }
            let t = e.toLowerCase(),
                r = "Other";
            t.includes("suv") || t.includes("4x4") || t.includes("crossover") ? r = "SUV" : t.includes("truck") || t.includes("pickup") ? r = "Truck" : t.includes("van") || t.includes("minivan") ? r = "Minivan" : t.includes("sedan") || t.includes("4-door") ? r = "Sedan" : t.includes("coupe") || t.includes("2-door") ? r = "Coupe" : t.includes("hatchback") ? r = "Hatchback" : t.includes("convertible") ? r = "Convertible" : t.includes("wagon") || t.includes("estate") ? r = "Wagon" : (t.includes("compact") || t.includes("small")) && (r = "Small Car");
            let o = "Gasoline";
            return t.includes("electric") || t.includes("ev") || t.includes("battery") ? o = "Electric" : t.includes("hybrid") || t.includes("hev") || t.includes("phev") ? o = "Hybrid" : t.includes("diesel") && (o = "Diesel"), {
                body_style: r,
                exterior_color: "Black",
                interior_color: "Black",
                fuel_type: o
            }
        }
        o.defineInteropFlag(r), o.export(r, "extractAttributesFromDescription", () => n)
    }, {
        "@parcel/transformer-js/src/esmodule-helpers.js": "cHUbl"
    }],
    eBThj: [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        o.defineInteropFlag(r), o.export(r, "applyCropToBlob", () => N), o.export(r, "fetchJson", () => L), o.export(r, "cleanSellerDesc", () => D), o.export(r, "cleanTextForGroup", () => M), o.export(r, "parsePrice", () => U), o.export(r, "SaveWebsiteInfoInLocal", () => $), o.export(r, "filterAllowedSites", () => F), o.export(r, "sanitizeVehiclesData", () => S), o.export(r, "listVehicleOnLocalStorage", () => d), o.export(r, "checkVehicles", () => u), o.export(r, "syncClientData", () => c), o.export(r, "csvJSON", () => l), o.export(r, "getPostedVehicles", () => s), o.export(r, "listVehicleOnServer", () => g), o.export(r, "cleanString", () => y), o.export(r, "getPreviousPostedVehiclesFromLocalStorage", () => w), o.export(r, "getWhereToPostData", () => b), o.export(r, "getGroupUrl", () => A), o.export(r, "getAlreadyAddedGroups", () => k), o.export(r, "checkIfAdded", () => x), o.export(r, "SaveFbGroup", () => T), o.export(r, "SaveGroupsData", () => _), o.export(r, "saveFbGroupsOnServer", () => E), o.export(r, "extractGroupTitle", () => C), o.export(r, "validateGroupData", () => v), o.export(r, "enterText", () => f), o.export(r, "findDivWithText", () => m), o.export(r, "uploadImagesFbGroups", () => I), o.export(r, "uploadImagesFbEvent", () => h), o.export(r, "updateVehiclePrice", () => p);
        var n = e("papaparse"),
            a = o.interopDefault(n),
            i = e("~common/browserMethods");

        function l(e) {
            try {
                if (!e || "string" != typeof e) throw Error("Invalid CSV input. Expected a non-empty string.");
                let t = (0, a.default).parse(e, {
                    header: !0,
                    skipEmptyLines: !0,
                    dynamicTyping: !1,
                    transformHeader: e => e.trim().replace(/\r/g, "")
                });
                return t.errors && t.errors.length > 0 && console.warn("CSV parse warnings:", t.errors), t.data || []
            } catch (e) {
                return console.error("Error parsing CSV:", e.message), []
            }
        }
        let s = async () => {
            let e = [],
                t = await chrome.storage.local.get("already_posted_vehicles");
            t && t?.already_posted_vehicles && (e = t?.already_posted_vehicles);
            let r = e.map(e => e?.vin);
            return r
        };
        async function c() {
            let e = await chrome.storage.local.get("password"),
                t = e?.password?.replace(/\"/g, ""),
                r = await fetch("https://sag.gemquery.com/api/v1/get-client", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        api_key: t
                    })
                }),
                o = await r.json();
            return o
        }

        function u(e, t) {
            return Array.isArray(t) ? t.map(t => {
                let r = t.VIN,
                    o = t.Title,
                    n = e?.some(e => e === r || e === o);
                return {
                    ...t,
                    Button: n ? "Post Again" : "Post"
                }
            }) : []
        }
        async function g(e, t, r) {
            let o = await chrome.storage.local.get("password"),
                n = o?.password?.replace(/\"/g, ""),
                a = await chrome.storage.local.get("salesManName"),
                i = a?.salesManName?.replace(/\"/g, "");
            i || (i = "Unknown");
            let l = {
                api_key: n,
                type: "listed_vehicle",
                vin: r,
                vehicle_url: e,
                listed_at: t,
                salesman_name: i
            };
            try {
                let e = await fetch("https://sag.gemquery.com/webhook/automotive", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify(l)
                    }),
                    t = await e.json();
                console.log(t, `Vehicle ${r} listed on server successfully`)
            } catch (e) {
                console.error(e)
            }
        }
        async function d(e, t, r, o = null) {
            let n = await chrome.storage.local.get("salesManName"),
                a = n?.salesManName?.replace(/\"/g, "");
            a || (a = "Unknown");
            let i = await chrome.storage.local.get("already_posted_vehicles"),
                l = [];
            l = i && i?.already_posted_vehicles ? i?.already_posted_vehicles : [], l?.push({
                vehicle_url: e,
                listed_at: t,
                vin: r,
                stock_number: o,
                salesman_name: a,
                price: null
            }), await chrome.storage.local.set({
                already_posted_vehicles: l
            });
            let s = await chrome.storage.local.get("soldVehicles"),
                c = [];
            s && s?.soldVehicles && (c = s?.soldVehicles);
            let u = c.findIndex(e => e.vin === r); - 1 !== u ? c[u] = {
                ...c[u],
                vehicle_url: e,
                listed_at: t,
                salesman_name: a
            } : c.push({
                vehicle_url: e,
                listed_at: t,
                vin: r,
                stock_number: o,
                salesman_name: a,
                price: null
            }), await chrome.storage.local.set({
                soldVehicles: c
            }), console.log(`Vehicle ${r} listed on local storage successfully`)
        }
        async function p(e, t) {
            try {
                let r = await chrome.storage.local.get("already_posted_vehicles"),
                    o = r?.already_posted_vehicles || [];
                o = o.map(r => r.vin === e ? {
                    ...r,
                    price: t
                } : r), await chrome.storage.local.set({
                    already_posted_vehicles: o
                });
                let n = await chrome.storage.local.get("soldVehicles"),
                    a = n?.soldVehicles || [];
                a = a.map(r => r.vin === e ? {
                    ...r,
                    price: t
                } : r), await chrome.storage.local.set({
                    soldVehicles: a
                }), console.log(`Price updated for vehicle ${e}: ${t}`)
            } catch (e) {
                console.error("Error updating vehicle price:", e)
            }
        }

        function m(e) {
            for (let t = 0; t < e?.length; t++) {
                let r = e[t]?.textContent || e[t]?.innerText || "";
                if (r?.trim() === "Photo/video") return e[t]
            }
            return null
        }
        let f = (e, t) => {
            e?.focus(), document.execCommand("insertText", !1, t)
        };
        async function h(e) {
            try {
                let t = new DataTransfer;
                for (let r of e) {
                    let e = await (0, i.runTimeMessage)({
                            message: "SET_BLOB_FROM_URL",
                            data: {
                                imageUrl: r
                            }
                        }),
                        o = await fetch(e?.data);
                    if (!o.ok) {
                        console.log("Failed to fetch image:", o);
                        continue
                    }
                    let n = await o.blob(),
                        a = new File([n], `${+new Date}.jpg`, {
                            type: "image/webp"
                        });
                    console.log("Image uploaded successfully", a.size), t.items.add(a), await (0, i.asyncSleep)(.1)
                }
                await new Promise(e => setTimeout(e, 100));
                let r = document.querySelectorAll('input[type="file"]'),
                    o = r[1];
                console.log(o, "fileInput"), o.files = t.files, o.dispatchEvent(new Event("change", {
                    bubbles: !0
                })), console.log("Images uploaded successfully")
            } catch (e) {
                console.error("Error uploading images:", e)
            }
        }
        let y = e => {
                try {
                    return e?.replace(/\\|"|\\r/g, "")
                } catch (e) {
                    return console.error("Error cleaning string:", e), ""
                }
            },
            w = async () => {
                let e = [],
                    t = await chrome.storage.local.get("already_posted_vehicles");
                t && t?.already_posted_vehicles && (e = t?.already_posted_vehicles);
                let r = e.map(e => e?.vehicle_url);
                return r
            };
        async function b() {
            let e, t;
            let r = await chrome.storage.local.get("facebookGroup"),
                o = await chrome.storage.local.get("whereToPost");
            r && (e = r?.facebookGroup?.replace(/\"/g, "")), o && (t = o?.whereToPost?.replace(/\"/g, ""));
            let n = {
                facebookGroup: e,
                whereToPost: t
            };
            return n
        }
        async function A(e) {
            let t = await chrome.storage.local.get("facebook_groups") || [];
            if (0 === Object.keys(t).length) return "Group title not found";
            for (let r of t?.facebook_groups)
                if (r?.name === e) return r?.url;
            return "Group title not found"
        }
        async function k() {
            let e = await chrome.storage.local.get("facebook_groups");
            if (Object?.keys(e)?.length === 0) return [];
            let t = e?.facebook_groups,
                r = t?.map(e => e.url);
            return r
        }
        async function x(e, t) {
            let r = e.element,
                o = r.querySelector("a"),
                n = o ? o.href : r?.href?.trim()?.replace('"', "")?.replace('"', "");
            try {
                let e = await k();
                t(e.includes(n))
            } catch (e) {
                console.error("Error checking if vehicle was posted:", e)
            }
        }

        function C(e) {
            try {
                if (!e || "string" != typeof e) throw Error("Invalid text input");
                let t = e?.split("\n"),
                    r = t?.filter(e => {
                        let t = e?.trim();
                        return !t?.toLowerCase()?.startsWith("view") && !t?.toLowerCase()?.endsWith("ago") && t.length > 0
                    }),
                    o = r?.join(" ")?.trim();
                if (!o || o.length < 3) throw Error("Group title too short or empty");
                let n = o?.replace("You", "")?.replace("you", "")?.replace("last", "")?.replace("Last", "")?.replace("visited", "")?.replace("visit", "")?.replace("Visit", "")?.replace("Visited", "")?.replace("have", "")?.replace("had", "")?.replace("weeks", "")?.replace("week", "")?.replace("ago", "")?.replace(/\b[1-9]\b/g, "")?.trim();
                if (!n || n.length < 3) throw Error("Group title too short after cleaning");
                return n
            } catch (e) {
                throw console.error("An error occurred while extracting the title:", e), Error("Unable to extract valid group title")
            }
        }

        function v(e, t) {
            try {
                if (!e || "string" != typeof e) return {
                    isValid: !1,
                    error: "Invalid group URL"
                };
                if (!e.includes("facebook.com/groups/")) return {
                    isValid: !1,
                    error: "URL must be a Facebook group URL"
                };
                if (!t || "string" != typeof t) return {
                    isValid: !1,
                    error: "Invalid group title"
                };
                if (t.length < 3) return {
                    isValid: !1,
                    error: "Group title must be at least 3 characters long"
                };
                if (t.length > 100) return {
                    isValid: !1,
                    error: "Group title must be less than 100 characters"
                };
                return {
                    isValid: !0
                }
            } catch (e) {
                return {
                    isValid: !1,
                    error: "Validation error"
                }
            }
        }
        async function T(e) {
            await chrome.storage.local.set({
                facebookGroup: e
            })
        }
        async function _(e) {
            let t = await chrome.storage.local.get("groupsData");
            if (0 === Object.keys(t).length) await chrome.storage.local.set({
                groupsData: [e]
            });
            else {
                let r = t.groupsData,
                    o = Array.from(new Set([...r, e]));
                await chrome.storage.local.set({
                    groupsData: o
                })
            }
        }
        async function E(e, t) {
            let r = await chrome.storage.local.get("password"),
                o = r?.password?.replace(/\"/g, "");
            if (!o) throw Error("No API key found. Please authenticate first.");
            if (!e || !t) throw Error("Invalid group data provided");
            if (!e.includes("facebook.com/groups/")) throw Error("Invalid Facebook group URL format");
            try {
                let r = await fetch("https://sag.gemquery.com/webhook/automotive", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        api_key: o,
                        type: "facebook_group_add",
                        facebook_group_name: t,
                        facebook_group_url: e
                    })
                });
                if (!r.ok) throw Error(`Server error: ${r.status} ${r.statusText}`);
                let n = await r.json();
                if (console.log(n, "data"), n.error) throw Error(n.error);
                return n
            } catch (e) {
                throw console.error("Error saving group to server:", e), e
            }
        }

        function S(e) {
            if (!Array.isArray(e)) return console.error("Input must be an array."), [];
            let t = /\s+/g,
                r = /\D/g;
            return e.map(e => {
                let o = {};
                for (let [n, a] of Object.entries(e)) {
                    if (null == a) continue;
                    let e = n.trim().replace(t, ""),
                        i = a;
                    if ("string" != typeof i || "" !== i.trim()) {
                        if ("string" == typeof i && (i = i.trim().replace(t, " ")), "imageurls" === e.toLowerCase()) {
                            "string" == typeof i ? o.ImageUrls = i.split(";").map(e => e.trim()).filter(Boolean) : Array.isArray(i) ? o.ImageUrls = i.map(e => "string" == typeof e ? e.trim() : "").filter(Boolean) : o.ImageUrls = [];
                            continue
                        }
                        if ("mileagevalue" === e.toLowerCase()) {
                            o.MileageValue = "string" == typeof i ? parseInt(i.replace(r, "")) || 0 : "number" == typeof i ? i : 0;
                            continue
                        }
                        if ("hardcodeddescription" === e.toLowerCase()) {
                            try {
                                "string" == typeof i && "" !== i.trim() ? o.HardcodedDescription = i.trim().replace(t, " ") : o.HardcodedDescription = ""
                            } catch (e) {
                                console.warn("Error processing HardcodedDescription field:", e), o.HardcodedDescription = ""
                            }
                            continue
                        }
                        if ("trim" === e.toLowerCase()) {
                            try {
                                "string" == typeof i && "" !== i.trim() ? o.Trim = i.trim().replace(t, " ") : o.Trim = ""
                            } catch (e) {
                                console.warn("Error processing Trim field:", e), o.Trim = ""
                            }
                            continue
                        }
                        if ("engine" === e.toLowerCase()) {
                            try {
                                if ("string" == typeof i && "" !== i.trim()) {
                                    let e = i.trim().replace(/\s+/g, " ").replace(/\r\n|\r|\n/g, "").trim();
                                    o.engine = e
                                } else "number" == typeof i ? o.engine = i.toString() + "L" : o.engine = ""
                            } catch (e) {
                                console.warn("Error processing engine field:", e), o.engine = ""
                            }
                            continue
                        }
                        o[e] = i
                    }
                }
                let n = o.Description || "";
                if (o.OriginalDescription = n, !n || "" === n.toString().trim() || "no description" === n.toString().trim().toLowerCase()) {
                    let e = ["imageurls", "url", "vehicleid", "vin", "latitude", "longitude", "lat", "lon", "mileagevalue", "stock_number", "id", "dealer_id", "dealerid"],
                        t = [],
                        r = o.Title || "",
                        n = o.Price || "";
                    for (let [a, i] of Object.entries(o)) {
                        let o = a.toLowerCase();
                        if (e.includes(o) || "originaldescription" === o || "description" === o || "title" === o || "price" === o || "button" === o || null == i) continue;
                        let l = i.toString().trim();
                        "" !== l && "0" !== l && l !== r && l !== n && t.push(`${a}: ${l}`)
                    }
                    t.length > 0 ? o.Description = t.join(". ") + "." : r && (o.Description = r)
                }
                return o
            })
        }

        function M(e) {
            if (!e) return "";
            let t = e.includes("\u2022") || e.includes("\n\u2022") || e.includes("Body Style:") && e.includes("Color:") || e.includes("Engine:") || e.includes("Exterior Color:");
            if (t) {
                let t = e.replace(/\\n/g, "\n").replace(/\n\s+/g, "\n").replace(/\s+(?=\n)/g, "").replace(/\s{2,}/g, " ").trim();
                return (t = t.replace(/\u2022\s*/g, "\n\u2022 ").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n")).replace(/::/g, ":")
            }
            let r = e.replace(/\\n/g, " ").replace(/\n/g, " ");
            r = (r = (r = r.replace(/[^a-zA-Z0-9.,!? ]/g, "")).replace(/\s+/g, " ").trim()).toLowerCase().replace(/(^\s*[a-z])|([.!?]\s*[a-z])/g, e => e.toUpperCase());
            let o = r.split(" ");
            return o.length > 200 && (r = o.slice(0, 200).join(" ")), r
        }
        async function I(e) {
            try {
                if (!e || 0 === e.length) {
                    console.warn("[UploadFBGroups] No image URLs provided");
                    return
                }
                console.log(`[UploadFBGroups] Starting upload for ${e.length} images`), console.log("[UploadFBGroups] URLs:", e.map((e, t) => `  ${t}: ${"string"==typeof e?e.substring(0,80):typeof e}`));
                let t = async (e, t = 8e3) => {
                    let r = new AbortController,
                        o = setTimeout(() => r.abort(), t);
                    try {
                        let t = await fetch(e, {
                            signal: r.signal
                        });
                        if (!t.ok) throw Error(`Direct fetch failed: ${t.status} ${t.statusText}`);
                        return await t.blob()
                    } finally {
                        clearTimeout(o)
                    }
                }, r = async e => {
                    let r = null;
                    try {
                        let t = await (0, i.runTimeMessage)({
                            message: "SET_BLOB_FROM_URL",
                            data: {
                                imageUrl: e
                            }
                        });
                        t?.success === !1 && (r = t?.error || "Background script failed to fetch image")
                    } catch (e) {
                        r = e
                    }
                    let o = "";
                    for (let e = 0; e < 120; e++) {
                        let e = await chrome.storage.local.get("imageBlog");
                        if (o = e?.imageBlog, "string" == typeof o && o.startsWith("data:")) break;
                        await (0, i.asyncSleep)(.05)
                    }
                    if (!o || "string" != typeof o) {
                        let e = r instanceof Error ? r.message : "string" == typeof r ? r : "No imageBlog data received from background storage";
                        throw Error(e)
                    }
                    if (await chrome.storage.local.set({
                            imageBlog: ""
                        }), o.startsWith("data:")) try {
                        let e = await fetch(o);
                        return await e.blob()
                    } catch (l) {
                        console.warn("[UploadFBGroups] data-URL fetch failed, trying manual parse");
                        let [e, t] = o.split(","), r = e.match(/data:(.*?);/), n = r ? r[1] : "image/jpeg", a = atob(t), i = new Uint8Array(a.length);
                        for (let e = 0; e < a.length; e++) i[e] = a.charCodeAt(e);
                        return new Blob([i], {
                            type: n
                        })
                    }
                    return await t(o)
                }, o = async (e, o) => {
                    let n = "string" == typeof e && (e.startsWith("blob:") || e.startsWith("data:"));
                    if (n) return await t(e);
                    try {
                        return console.log(`[UploadFBGroups] Image ${o+1}: trying background-storage fetch`), await r(e)
                    } catch (r) {
                        return console.warn(`[UploadFBGroups] Image ${o+1}: background-storage fetch failed, trying direct fetch:`, r), await t(e)
                    }
                }, n = null, a = new DataTransfer, l = 0;
                for (let t = 0; t < e.length; t++) {
                    let r = e[t];
                    if (!r || "string" != typeof r) {
                        console.warn(`Skipping invalid image URL at index ${t}:`, r);
                        continue
                    }
                    let n = 0,
                        s = !1;
                    for (; n < 2 && !s;) try {
                        let n = await o(r, t);
                        if (!n || 0 === n.size) throw Error("Empty or invalid blob data");
                        if (n.size > 4194304) {
                            console.warn(`Skipping image ${t+1}/${e.length}: Size ${(n.size/1024/1024).toFixed(2)}MB exceeds 4MB limit`), s = !0;
                            continue
                        }
                        let c = Date.now(),
                            u = Math.random().toString(36).substr(2, 9),
                            g = `image_${c}_${u}.jpg`,
                            d = new File([n], g, {
                                type: "image/jpeg",
                                lastModified: c
                            });
                        a.items.add(d), l++, s = !0, console.log(`Successfully processed image ${t+1}/${e.length} (${(n.size/1024).toFixed(2)}KB)`), await (0, i.asyncSleep)(.05)
                    } catch (r) {
                        n++, console.warn(`Attempt ${n}/2 failed for image ${t+1}:`, r.message), n < 2 ? await (0, i.asyncSleep)(.2 * Math.pow(2, n)) : (console.error(`Failed to process image ${t+1}/${e.length} after 2 attempts:`, r), s = !0)
                    }
                }
                if (0 === l) {
                    console.error("[UploadFBGroups] No images were successfully processed \u2014 aborting upload");
                    return
                }
                if (console.log(`[UploadFBGroups] Successfully processed ${l}/${e.length} images, total files in DataTransfer: ${a.files.length}`), !(n = await O())) {
                    console.error("[UploadFBGroups] Could not find any file input element on the page"), console.log("[UploadFBGroups] All inputs on page:", document.querySelectorAll("input").length), console.log("[UploadFBGroups] File inputs on page:", document.querySelectorAll('input[type="file"]').length);
                    return
                }
                console.log(`[UploadFBGroups] File input found. Accept: ${n.accept||"any"}, Multiple: ${n.multiple}`);
                try {
                    let e = !1,
                        t = (() => {
                            let e = ["add photos", "add photo", "photo/video", "photos", "photo"],
                                t = Array.from(document.querySelectorAll('span[dir="auto"]')),
                                r = t.find(t => {
                                    let r = (t.textContent || "").trim().toLowerCase();
                                    return e.includes(r)
                                });
                            if (r && r instanceof HTMLElement) return r;
                            let o = Array.from(document.querySelectorAll('[role="button"], button, [tabindex="0"]')),
                                n = o.find(t => {
                                    let r = (t.textContent || "").trim().toLowerCase();
                                    return e.includes(r)
                                });
                            return n || null
                        })();
                    if (t && (e = ((e, t) => {
                            try {
                                let r = new DataTransfer;
                                Array.from(t).forEach(e => r.items.add(e));
                                let o = e => {
                                    try {
                                        return new DragEvent(e, {
                                            bubbles: !0,
                                            cancelable: !0,
                                            dataTransfer: r
                                        })
                                    } catch {
                                        let t = document.createEvent("Event");
                                        return t.initEvent(e, !0, !0), Object.defineProperty(t, "dataTransfer", {
                                            value: r
                                        }), t
                                    }
                                };
                                return e.dispatchEvent(o("dragenter")), e.dispatchEvent(o("dragover")), e.dispatchEvent(o("drop")), !0
                            } catch (e) {
                                return console.warn("[Groups] Drag-drop upload failed:", e), !1
                            }
                        })(t, a.files)), !e) {
                        for (let e of (n.files = a.files, ["change", "input"])) {
                            let t = new Event(e, {
                                bubbles: !0,
                                cancelable: !0
                            });
                            n.dispatchEvent(t), await (0, i.asyncSleep)(.02)
                        }
                        e = !0
                    }
                    console.log(`[UploadFBGroups] Upload triggered successfully with ${a.files.length} files (method: ${t&&e?"drag-drop":"file-input"})`)
                } catch (e) {
                    throw console.error("[UploadFBGroups] Error triggering file upload:", e), e
                }
            } catch (e) {
                throw console.error("[UploadFBGroups] Critical error:", e), e
            }
        }
        async function O() {
            let e = [() => {
                let e = document.querySelector('[role="dialog"] form');
                return e?.querySelector('input[type="file"]')
            }, () => {
                let e = document.querySelectorAll('input[type="file"]');
                for (let t of e) {
                    let e = window.getComputedStyle(t);
                    if ("none" !== e.display && "hidden" !== e.visibility) return t
                }
                return null
            }, () => {
                let e = document.querySelectorAll('input[type="file"]');
                return e.length > 0 ? e[0] : null
            }, async () => {
                await (0, i.asyncSleep)(.5);
                let e = document.querySelectorAll('input[type="file"]');
                return e.length > 0 ? e[0] : null
            }];
            for (let t = 0; t < e.length; t++) try {
                let r = await e[t]();
                if (r) return console.log(`File input found using strategy ${t+1}`), r
            } catch (e) {
                console.warn(`Strategy ${t+1} failed:`, e.message)
            }
            return null
        }

        function F(e, t) {
            try {
                if (!Array.isArray(e)) throw Error("allowedWebsites must be an array");
                if (!Array.isArray(t)) throw Error("allSitesData must be an array");
                return t.filter(t => e.includes(t?.website_url))
            } catch (e) {
                return console.error("Error in filterAllowedSites:", e), []
            }
        }
        async function $(e, t) {
            try {
                let r = e?.split(",")?.map(e => e?.trim());
                await chrome.storage.local.set({
                    allowedWebsites: r
                });
                let o = await fetch("https://sag.gemquery.com/api/v1/get-website"),
                    n = await o.json(),
                    a = F(r, n.websites);
                "hamzamaqbool@gmail.com" == t ? await chrome.storage.local.set({
                    siteDetails: n.websites
                }) : await chrome.storage.local.set({
                    siteDetails: a
                })
            } catch (e) {
                console.error(e)
            }
        }
        let U = e => {
            if (!e) return 0;
            let t = e.replace(/C\$|CAD\$|\$|\u20ac|\u00a3|\u20b9|\u00a5|\u20a9|\u20b1|\u20bd/g, "").replace(/,/g, "").replace(/\s+/g, "").replace(/[^\d.-]/g, "");
            t.includes("-") && (t = t.split("-")[0]), (t.includes("/mo") || t.includes("/month")) && (t = t.replace(/\/mo.*|\/month.*/, ""));
            let r = parseFloat(t);
            return isNaN(r) ? 0 : r
        };

        function D(e) {
            if (!e) return "";
            let t = e.replace(/\\n/g, "\n"),
                r = t.replace(/\s+/g, " "),
                o = r.replace(/\n+/g, "\n").trim();
            return o
        }
        async function L(e, t) {
            let r = await fetch(e, t);
            if (!r.ok) throw Error(`HTTP error! status: ${r.status}`);
            return await r.json()
        }
        async function N(e, t) {
            try {
                if (!t || 0 === t.top && 0 === t.bottom && 0 === t.left && 0 === t.right) return e;
                let r = new Image,
                    o = URL.createObjectURL(e);
                await new Promise((e, t) => {
                    r.onload = e, r.onerror = t, r.src = o
                });
                let n = document.createElement("canvas"),
                    a = n.getContext("2d");
                if (!a) return console.error("Failed to get canvas context"), e;
                let i = r.height * t.top / 100,
                    l = r.height * t.bottom / 100,
                    s = r.width * t.left / 100,
                    c = r.width * t.right / 100,
                    u = r.width - s - c,
                    g = r.height - i - l;
                return n.width = u, n.height = g, a.drawImage(r, s, i, u, g, 0, 0, u, g), URL.revokeObjectURL(o), new Promise((t, r) => {
                    n.toBlob(o => {
                        o ? (console.log(`Image cropped successfully. Original: ${(e.size/1024).toFixed(2)}KB, Cropped: ${(o.size/1024).toFixed(2)}KB`), t(o)) : r(Error("Failed to create cropped blob"))
                    }, "image/jpeg", .9)
                })
            } catch (t) {
                return console.error("Error applying crop to blob:", t), e
            }
        }
    }, {
        papaparse: "86e0m",
        "~common/browserMethods": "92Ssc",
        "@parcel/transformer-js/src/esmodule-helpers.js": "cHUbl"
    }],
    "86e0m": [function(t, r, o) {
        var n;
        n = function e() {
            var t, r = "undefined" != typeof self ? self : "undefined" != typeof window ? window : void 0 !== r ? r : {},
                o = !r.document && !!r.postMessage,
                n = r.IS_PAPA_WORKER || !1,
                a = {},
                i = 0,
                l = {};

            function s(e) {
                this._handle = null, this._finished = !1, this._completed = !1, this._halted = !1, this._input = null, this._baseIndex = 0, this._partialLine = "", this._rowCount = 0, this._start = 0, this._nextChunk = null, this.isFirstChunk = !0, this._completeResults = {
                    data: [],
                    errors: [],
                    meta: {}
                }, (function(e) {
                    var t = b(e);
                    t.chunkSize = parseInt(t.chunkSize), e.step || e.chunk || (t.chunkSize = null), this._handle = new p(t), (this._handle.streamer = this)._config = t
                }).call(this, e), this.parseChunk = function(e, t) {
                    var o = parseInt(this._config.skipFirstNLines) || 0;
                    if (this.isFirstChunk && 0 < o) {
                        let t = this._config.newline;
                        t || (a = this._config.quoteChar || '"', t = this._handle.guessLineEndings(e, a)), e = [...e.split(t).slice(o)].join(t)
                    }
                    this.isFirstChunk && k(this._config.beforeFirstChunk) && void 0 !== (a = this._config.beforeFirstChunk(e)) && (e = a), this.isFirstChunk = !1, this._halted = !1;
                    var o = this._partialLine + e,
                        a = (this._partialLine = "", this._handle.parse(o, this._baseIndex, !this._finished));
                    if (!this._handle.paused() && !this._handle.aborted()) {
                        if (e = a.meta.cursor, this._finished || (this._partialLine = o.substring(e - this._baseIndex), this._baseIndex = e), a && a.data && (this._rowCount += a.data.length), o = this._finished || this._config.preview && this._rowCount >= this._config.preview, n) r.postMessage({
                            results: a,
                            workerId: l.WORKER_ID,
                            finished: o
                        });
                        else if (k(this._config.chunk) && !t) {
                            if (this._config.chunk(a, this._handle), this._handle.paused() || this._handle.aborted()) return void(this._halted = !0);
                            this._completeResults = a = void 0
                        }
                        return this._config.step || this._config.chunk || (this._completeResults.data = this._completeResults.data.concat(a.data), this._completeResults.errors = this._completeResults.errors.concat(a.errors), this._completeResults.meta = a.meta), this._completed || !o || !k(this._config.complete) || a && a.meta.aborted || (this._config.complete(this._completeResults, this._input), this._completed = !0), o || a && a.meta.paused || this._nextChunk(), a
                    }
                    this._halted = !0
                }, this._sendError = function(e) {
                    k(this._config.error) ? this._config.error(e) : n && this._config.error && r.postMessage({
                        workerId: l.WORKER_ID,
                        error: e,
                        finished: !1
                    })
                }
            }

            function c(e) {
                var t;
                (e = e || {}).chunkSize || (e.chunkSize = l.RemoteChunkSize), s.call(this, e), this._nextChunk = o ? function() {
                    this._readChunk(), this._chunkLoaded()
                } : function() {
                    this._readChunk()
                }, this.stream = function(e) {
                    this._input = e, this._nextChunk()
                }, this._readChunk = function() {
                    if (this._finished) this._chunkLoaded();
                    else {
                        if (t = new XMLHttpRequest, this._config.withCredentials && (t.withCredentials = this._config.withCredentials), o || (t.onload = A(this._chunkLoaded, this), t.onerror = A(this._chunkError, this)), t.open(this._config.downloadRequestBody ? "POST" : "GET", this._input, !o), this._config.downloadRequestHeaders) {
                            var e, r, n = this._config.downloadRequestHeaders;
                            for (r in n) t.setRequestHeader(r, n[r])
                        }
                        this._config.chunkSize && (e = this._start + this._config.chunkSize - 1, t.setRequestHeader("Range", "bytes=" + this._start + "-" + e));
                        try {
                            t.send(this._config.downloadRequestBody)
                        } catch (e) {
                            this._chunkError(e.message)
                        }
                        o && 0 === t.status && this._chunkError()
                    }
                }, this._chunkLoaded = function() {
                    var e;
                    4 === t.readyState && (t.status < 200 || 400 <= t.status ? this._chunkError() : (this._start += this._config.chunkSize || t.responseText.length, this._finished = !this._config.chunkSize || this._start >= (null !== (e = (e = t).getResponseHeader("Content-Range")) ? parseInt(e.substring(e.lastIndexOf("/") + 1)) : -1), this.parseChunk(t.responseText)))
                }, this._chunkError = function(e) {
                    e = t.statusText || e, this._sendError(Error(e))
                }
            }

            function u(e) {
                (e = e || {}).chunkSize || (e.chunkSize = l.LocalChunkSize), s.call(this, e);
                var t, r, o = "undefined" != typeof FileReader;
                this.stream = function(e) {
                    this._input = e, r = e.slice || e.webkitSlice || e.mozSlice, o ? ((t = new FileReader).onload = A(this._chunkLoaded, this), t.onerror = A(this._chunkError, this)) : t = new FileReaderSync, this._nextChunk()
                }, this._nextChunk = function() {
                    this._finished || this._config.preview && !(this._rowCount < this._config.preview) || this._readChunk()
                }, this._readChunk = function() {
                    var e = this._input,
                        n = (this._config.chunkSize && (n = Math.min(this._start + this._config.chunkSize, this._input.size), e = r.call(e, this._start, n)), t.readAsText(e, this._config.encoding));
                    o || this._chunkLoaded({
                        target: {
                            result: n
                        }
                    })
                }, this._chunkLoaded = function(e) {
                    this._start += this._config.chunkSize, this._finished = !this._config.chunkSize || this._start >= this._input.size, this.parseChunk(e.target.result)
                }, this._chunkError = function() {
                    this._sendError(t.error)
                }
            }

            function g(e) {
                var t;
                s.call(this, e = e || {}), this.stream = function(e) {
                    return t = e, this._nextChunk()
                }, this._nextChunk = function() {
                    var e, r;
                    if (!this._finished) return t = (e = this._config.chunkSize) ? (r = t.substring(0, e), t.substring(e)) : (r = t, ""), this._finished = !t, this.parseChunk(r)
                }
            }

            function d(e) {
                s.call(this, e = e || {});
                var t = [],
                    r = !0,
                    o = !1;
                this.pause = function() {
                    s.prototype.pause.apply(this, arguments), this._input.pause()
                }, this.resume = function() {
                    s.prototype.resume.apply(this, arguments), this._input.resume()
                }, this.stream = function(e) {
                    this._input = e, this._input.on("data", this._streamData), this._input.on("end", this._streamEnd), this._input.on("error", this._streamError)
                }, this._checkIsFinished = function() {
                    o && 1 === t.length && (this._finished = !0)
                }, this._nextChunk = function() {
                    this._checkIsFinished(), t.length ? this.parseChunk(t.shift()) : r = !0
                }, this._streamData = A(function(e) {
                    try {
                        t.push("string" == typeof e ? e : e.toString(this._config.encoding)), r && (r = !1, this._checkIsFinished(), this.parseChunk(t.shift()))
                    } catch (e) {
                        this._streamError(e)
                    }
                }, this), this._streamError = A(function(e) {
                    this._streamCleanUp(), this._sendError(e)
                }, this), this._streamEnd = A(function() {
                    this._streamCleanUp(), o = !0, this._streamData("")
                }, this), this._streamCleanUp = A(function() {
                    this._input.removeListener("data", this._streamData), this._input.removeListener("end", this._streamEnd), this._input.removeListener("error", this._streamError)
                }, this)
            }

            function p(e) {
                var t, r, o, n, a = /^\s*-?(\d+\.?|\.\d+|\d+\.\d+)([eE][-+]?\d+)?\s*$/,
                    i = /^((\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)))$/,
                    s = this,
                    c = 0,
                    u = 0,
                    g = !1,
                    d = !1,
                    p = [],
                    h = {
                        data: [],
                        errors: [],
                        meta: {}
                    };

                function y(t) {
                    return "greedy" === e.skipEmptyLines ? "" === t.join("").trim() : 1 === t.length && 0 === t[0].length
                }

                function w() {
                    if (h && o && (x("Delimiter", "UndetectableDelimiter", "Unable to auto-detect delimiting character; defaulted to '" + l.DefaultDelimiter + "'"), o = !1), e.skipEmptyLines && (h.data = h.data.filter(function(e) {
                            return !y(e)
                        })), A()) {
                        if (h) {
                            if (Array.isArray(h.data[0])) {
                                for (var t, r = 0; A() && r < h.data.length; r++) h.data[r].forEach(n);
                                h.data.splice(0, 1)
                            } else h.data.forEach(n)
                        }

                        function n(t, r) {
                            k(e.transformHeader) && (t = e.transformHeader(t, r)), p.push(t)
                        }
                    }

                    function s(t, r) {
                        for (var o = e.header ? {} : [], n = 0; n < t.length; n++) {
                            var l, s, c = n,
                                g = t[n],
                                g = (l = c = e.header ? n >= p.length ? "__parsed_extra" : p[n] : c, s = g = e.transform ? e.transform(g, c) : g, (e.dynamicTypingFunction && void 0 === e.dynamicTyping[l] && (e.dynamicTyping[l] = e.dynamicTypingFunction(l)), !0 === (e.dynamicTyping[l] || e.dynamicTyping)) ? "true" === s || "TRUE" === s || "false" !== s && "FALSE" !== s && ((e => {
                                    if (a.test(e) && -9007199254740992 < (e = parseFloat(e)) && e < 9007199254740992) return 1
                                })(s) ? parseFloat(s) : i.test(s) ? new Date(s) : "" === s ? null : s) : s);
                            "__parsed_extra" === c ? (o[c] = o[c] || [], o[c].push(g)) : o[c] = g
                        }
                        return e.header && (n > p.length ? x("FieldMismatch", "TooManyFields", "Too many fields: expected " + p.length + " fields but parsed " + n, u + r) : n < p.length && x("FieldMismatch", "TooFewFields", "Too few fields: expected " + p.length + " fields but parsed " + n, u + r)), o
                    }
                    h && (e.header || e.dynamicTyping || e.transform) && (t = 1, !h.data.length || Array.isArray(h.data[0]) ? (h.data = h.data.map(s), t = h.data.length) : h.data = s(h.data, 0), e.header && h.meta && (h.meta.fields = p), u += t)
                }

                function A() {
                    return e.header && 0 === p.length
                }

                function x(e, t, r, o) {
                    e = {
                        type: e,
                        code: t,
                        message: r
                    }, void 0 !== o && (e.row = o), h.errors.push(e)
                }
                k(e.step) && (n = e.step, e.step = function(t) {
                    h = t, A() ? w() : (w(), 0 !== h.data.length && (c += t.data.length, e.preview && c > e.preview ? r.abort() : (h.data = h.data[0], n(h, s))))
                }), this.parse = function(n, a, i) {
                    var s = e.quoteChar || '"',
                        s = (e.newline || (e.newline = this.guessLineEndings(n, s)), o = !1, e.delimiter ? k(e.delimiter) && (e.delimiter = e.delimiter(n), h.meta.delimiter = e.delimiter) : ((s = ((t, r, o, n, a) => {
                            var i, s, c, u;
                            a = a || [",", "	", "|", ";", l.RECORD_SEP, l.UNIT_SEP];
                            for (var g = 0; g < a.length; g++) {
                                for (var d, p = a[g], m = 0, h = 0, w = 0, b = (c = void 0, new f({
                                        comments: n,
                                        delimiter: p,
                                        newline: r,
                                        preview: 10
                                    }).parse(t)), A = 0; A < b.data.length; A++) o && y(b.data[A]) ? w++ : (h += d = b.data[A].length, void 0 === c ? c = d : 0 < d && (m += Math.abs(d - c), c = d));
                                0 < b.data.length && (h /= b.data.length - w), (void 0 === s || m <= s) && (void 0 === u || u < h) && 1.99 < h && (s = m, i = p, u = h)
                            }
                            return {
                                successful: !!(e.delimiter = i),
                                bestDelimiter: i
                            }
                        })(n, e.newline, e.skipEmptyLines, e.comments, e.delimitersToGuess)).successful ? e.delimiter = s.bestDelimiter : (o = !0, e.delimiter = l.DefaultDelimiter), h.meta.delimiter = e.delimiter), b(e));
                    return e.preview && e.header && s.preview++, t = n, h = (r = new f(s)).parse(t, a, i), w(), g ? {
                        meta: {
                            paused: !0
                        }
                    } : h || {
                        meta: {
                            paused: !1
                        }
                    }
                }, this.paused = function() {
                    return g
                }, this.pause = function() {
                    g = !0, r.abort(), t = k(e.chunk) ? "" : t.substring(r.getCharIndex())
                }, this.resume = function() {
                    s.streamer._halted ? (g = !1, s.streamer.parseChunk(t, !0)) : setTimeout(s.resume, 3)
                }, this.aborted = function() {
                    return d
                }, this.abort = function() {
                    d = !0, r.abort(), h.meta.aborted = !0, k(e.complete) && e.complete(h), t = ""
                }, this.guessLineEndings = function(e, t) {
                    e = e.substring(0, 1048576);
                    var t = RegExp(m(t) + "([^]*?)" + m(t), "gm"),
                        r = (e = e.replace(t, "")).split("\r"),
                        t = e.split("\n"),
                        e = 1 < t.length && t[0].length < r[0].length;
                    if (1 === r.length || e) return "\n";
                    for (var o = 0, n = 0; n < r.length; n++) "\n" === r[n][0] && o++;
                    return o >= r.length / 2 ? "\r\n" : "\r"
                }
            }

            function m(e) {
                return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            }

            function f(e) {
                var t = (e = e || {}).delimiter,
                    r = e.newline,
                    o = e.comments,
                    n = e.step,
                    a = e.preview,
                    i = e.fastMode,
                    s = null,
                    c = !1,
                    u = null == e.quoteChar ? '"' : e.quoteChar,
                    g = u;
                if (void 0 !== e.escapeChar && (g = e.escapeChar), ("string" != typeof t || -1 < l.BAD_DELIMITERS.indexOf(t)) && (t = ","), o === t) throw Error("Comment character same as delimiter");
                !0 === o ? o = "#" : ("string" != typeof o || -1 < l.BAD_DELIMITERS.indexOf(o)) && (o = !1), "\n" !== r && "\r" !== r && "\r\n" !== r && (r = "\n");
                var d = 0,
                    p = !1;
                this.parse = function(l, f, h) {
                    if ("string" != typeof l) throw Error("Input must be a string");
                    var y = l.length,
                        w = t.length,
                        b = r.length,
                        A = o.length,
                        x = k(n),
                        C = [],
                        v = [],
                        T = [],
                        _ = d = 0;
                    if (!l) return R();
                    if (i || !1 !== i && -1 === l.indexOf(u)) {
                        for (var E = l.split(r), S = 0; S < E.length; S++) {
                            if (T = E[S], d += T.length, S !== E.length - 1) d += r.length;
                            else if (h) break;
                            if (!o || T.substring(0, A) !== o) {
                                if (x) {
                                    if (C = [], U(T.split(t)), P(), p) return R()
                                } else U(T.split(t));
                                if (a && a <= S) return C = C.slice(0, a), R(!0)
                            }
                        }
                        return R()
                    }
                    for (var M = l.indexOf(t, d), I = l.indexOf(r, d), O = RegExp(m(g) + m(u), "g"), F = l.indexOf(u, d);;)
                        if (l[d] === u)
                            for (F = d, d++;;) {
                                if (-1 === (F = l.indexOf(u, F + 1))) return h || v.push({
                                    type: "Quotes",
                                    code: "MissingQuotes",
                                    message: "Quoted field unterminated",
                                    row: C.length,
                                    index: d
                                }), L();
                                if (F === y - 1) return L(l.substring(d, F).replace(O, u));
                                if (u === g && l[F + 1] === g) F++;
                                else if (u === g || 0 === F || l[F - 1] !== g) {
                                    -1 !== M && M < F + 1 && (M = l.indexOf(t, F + 1));
                                    var $ = D(-1 === (I = -1 !== I && I < F + 1 ? l.indexOf(r, F + 1) : I) ? M : Math.min(M, I));
                                    if (l.substr(F + 1 + $, w) === t) {
                                        T.push(l.substring(d, F).replace(O, u)), l[d = F + 1 + $ + w] !== u && (F = l.indexOf(u, d)), M = l.indexOf(t, d), I = l.indexOf(r, d);
                                        break
                                    }
                                    if ($ = D(I), l.substring(F + 1 + $, F + 1 + $ + b) === r) {
                                        if (T.push(l.substring(d, F).replace(O, u)), N(F + 1 + $ + b), M = l.indexOf(t, d), F = l.indexOf(u, d), x && (P(), p)) return R();
                                        if (a && C.length >= a) return R(!0);
                                        break
                                    }
                                    v.push({
                                        type: "Quotes",
                                        code: "InvalidQuotes",
                                        message: "Trailing quote on quoted field is malformed",
                                        row: C.length,
                                        index: d
                                    }), F++
                                }
                            } else if (o && 0 === T.length && l.substring(d, d + A) === o) {
                                if (-1 === I) return R();
                                d = I + b, I = l.indexOf(r, d), M = l.indexOf(t, d)
                            } else if (-1 !== M && (M < I || -1 === I)) T.push(l.substring(d, M)), d = M + w, M = l.indexOf(t, d);
                    else {
                        if (-1 === I) break;
                        if (T.push(l.substring(d, I)), N(I + b), x && (P(), p)) return R();
                        if (a && C.length >= a) return R(!0)
                    }
                    return L();

                    function U(e) {
                        C.push(e), _ = d
                    }

                    function D(e) {
                        return -1 !== e && (e = l.substring(F + 1, e)) && "" === e.trim() ? e.length : 0
                    }

                    function L(e) {
                        return h || (void 0 === e && (e = l.substring(d)), T.push(e), d = y, U(T), x && P()), R()
                    }

                    function N(e) {
                        d = e, U(T), T = [], I = l.indexOf(r, d)
                    }

                    function R(o) {
                        if (e.header && !f && C.length && !c) {
                            var n = C[0],
                                a = Object.create(null),
                                i = new Set(n);
                            let t = !1;
                            for (let r = 0; r < n.length; r++) {
                                let o = n[r];
                                if (a[o = k(e.transformHeader) ? e.transformHeader(o, r) : o]) {
                                    let e, l = a[o];
                                    for (; e = o + "_" + l, l++, i.has(e););
                                    i.add(e), n[r] = e, a[o]++, t = !0, (s = null === s ? {} : s)[e] = o
                                } else a[o] = 1, n[r] = o;
                                i.add(o)
                            }
                            t && console.warn("Duplicate headers found and renamed."), c = !0
                        }
                        return {
                            data: C,
                            errors: v,
                            meta: {
                                delimiter: t,
                                linebreak: r,
                                aborted: p,
                                truncated: !!o,
                                cursor: _ + (f || 0),
                                renamedHeaders: s
                            }
                        }
                    }

                    function P() {
                        n(R()), C = [], v = []
                    }
                }, this.abort = function() {
                    p = !0
                }, this.getCharIndex = function() {
                    return d
                }
            }

            function h(e) {
                var t = e.data,
                    r = a[t.workerId],
                    o = !1;
                if (t.error) r.userError(t.error, t.file);
                else if (t.results && t.results.data) {
                    var n = {
                        abort: function() {
                            o = !0, y(t.workerId, {
                                data: [],
                                errors: [],
                                meta: {
                                    aborted: !0
                                }
                            })
                        },
                        pause: w,
                        resume: w
                    };
                    if (k(r.userStep)) {
                        for (var i = 0; i < t.results.data.length && (r.userStep({
                                data: t.results.data[i],
                                errors: t.results.errors,
                                meta: t.results.meta
                            }, n), !o); i++);
                        delete t.results
                    } else k(r.userChunk) && (r.userChunk(t.results, n, t.file), delete t.results)
                }
                t.finished && !o && y(t.workerId, t.results)
            }

            function y(e, t) {
                var r = a[e];
                k(r.userComplete) && r.userComplete(t), r.terminate(), delete a[e]
            }

            function w() {
                throw Error("Not implemented.")
            }

            function b(e) {
                if ("object" != typeof e || null === e) return e;
                var t, r = Array.isArray(e) ? [] : {};
                for (t in e) r[t] = b(e[t]);
                return r
            }

            function A(e, t) {
                return function() {
                    e.apply(t, arguments)
                }
            }

            function k(e) {
                return "function" == typeof e
            }
            return l.parse = function(t, o) {
                var n, s, p, m, f = (o = o || {}).dynamicTyping || !1;
                if (k(f) && (o.dynamicTypingFunction = f, f = {}), o.dynamicTyping = f, o.transform = !!k(o.transform) && o.transform, !o.worker || !l.WORKERS_SUPPORTED) return f = null, l.NODE_STREAM_INPUT, "string" == typeof t ? (t = 65279 !== (n = t).charCodeAt(0) ? n : n.slice(1), f = new(o.download ? c : g)(o)) : !0 === t.readable && k(t.read) && k(t.on) ? f = new d(o) : (r.File && t instanceof File || t instanceof Object) && (f = new u(o)), f.stream(t);
                (f = !!l.WORKERS_SUPPORTED && (p = r.URL || r.webkitURL || null, m = e.toString(), s = l.BLOB_URL || (l.BLOB_URL = p.createObjectURL(new Blob(["var global = (function() { if (typeof self !== 'undefined') { return self; } if (typeof window !== 'undefined') { return window; } if (typeof global !== 'undefined') { return global; } return {}; })(); global.IS_PAPA_WORKER=true; ", "(", m, ")();"], {
                    type: "text/javascript"
                }))), (s = new r.Worker(s)).onmessage = h, s.id = i++, a[s.id] = s)).userStep = o.step, f.userChunk = o.chunk, f.userComplete = o.complete, f.userError = o.error, o.step = k(o.step), o.chunk = k(o.chunk), o.complete = k(o.complete), o.error = k(o.error), delete o.worker, f.postMessage({
                    input: t,
                    config: o,
                    workerId: f.id
                })
            }, l.unparse = function(e, t) {
                var r = !1,
                    o = !0,
                    n = ",",
                    a = "\r\n",
                    i = '"',
                    s = i + i,
                    c = !1,
                    u = null,
                    g = !1,
                    d = ((() => {
                        if ("object" == typeof t) {
                            if ("string" != typeof t.delimiter || l.BAD_DELIMITERS.filter(function(e) {
                                    return -1 !== t.delimiter.indexOf(e)
                                }).length || (n = t.delimiter), ("boolean" == typeof t.quotes || "function" == typeof t.quotes || Array.isArray(t.quotes)) && (r = t.quotes), "boolean" != typeof t.skipEmptyLines && "string" != typeof t.skipEmptyLines || (c = t.skipEmptyLines), "string" == typeof t.newline && (a = t.newline), "string" == typeof t.quoteChar && (i = t.quoteChar), "boolean" == typeof t.header && (o = t.header), Array.isArray(t.columns)) {
                                if (0 === t.columns.length) throw Error("Option columns is empty");
                                u = t.columns
                            }
                            void 0 !== t.escapeChar && (s = t.escapeChar + i), t.escapeFormulae instanceof RegExp ? g = t.escapeFormulae : "boolean" == typeof t.escapeFormulae && t.escapeFormulae && (g = /^[=+\-@\t\r].*$/)
                        }
                    })(), RegExp(m(i), "g"));
                if ("string" == typeof e && (e = JSON.parse(e)), Array.isArray(e)) {
                    if (!e.length || Array.isArray(e[0])) return p(null, e, c);
                    if ("object" == typeof e[0]) return p(u || Object.keys(e[0]), e, c)
                } else if ("object" == typeof e) return "string" == typeof e.data && (e.data = JSON.parse(e.data)), Array.isArray(e.data) && (e.fields || (e.fields = e.meta && e.meta.fields || u), e.fields || (e.fields = Array.isArray(e.data[0]) ? e.fields : "object" == typeof e.data[0] ? Object.keys(e.data[0]) : []), Array.isArray(e.data[0]) || "object" == typeof e.data[0] || (e.data = [e.data])), p(e.fields || [], e.data || [], c);
                throw Error("Unable to serialize unrecognized input");

                function p(e, t, r) {
                    var i = "",
                        l = ("string" == typeof e && (e = JSON.parse(e)), "string" == typeof t && (t = JSON.parse(t)), Array.isArray(e) && 0 < e.length),
                        s = !Array.isArray(t[0]);
                    if (l && o) {
                        for (var c = 0; c < e.length; c++) 0 < c && (i += n), i += f(e[c], c);
                        0 < t.length && (i += a)
                    }
                    for (var u = 0; u < t.length; u++) {
                        var g = (l ? e : t[u]).length,
                            d = !1,
                            p = l ? 0 === Object.keys(t[u]).length : 0 === t[u].length;
                        if (r && !l && (d = "greedy" === r ? "" === t[u].join("").trim() : 1 === t[u].length && 0 === t[u][0].length), "greedy" === r && l) {
                            for (var m = [], h = 0; h < g; h++) {
                                var y = s ? e[h] : h;
                                m.push(t[u][y])
                            }
                            d = "" === m.join("").trim()
                        }
                        if (!d) {
                            for (var w = 0; w < g; w++) {
                                0 < w && !p && (i += n);
                                var b = l && s ? e[w] : w;
                                i += f(t[u][b], w)
                            }
                            u < t.length - 1 && (!r || 0 < g && !p) && (i += a)
                        }
                    }
                    return i
                }

                function f(e, t) {
                    var o, a;
                    return null == e ? "" : e.constructor === Date ? JSON.stringify(e).slice(1, 25) : (a = !1, g && "string" == typeof e && g.test(e) && (e = "'" + e, a = !0), o = e.toString().replace(d, s), (a = a || !0 === r || "function" == typeof r && r(e, t) || Array.isArray(r) && r[t] || ((e, t) => {
                        for (var r = 0; r < t.length; r++)
                            if (-1 < e.indexOf(t[r])) return !0;
                        return !1
                    })(o, l.BAD_DELIMITERS) || -1 < o.indexOf(n) || " " === o.charAt(0) || " " === o.charAt(o.length - 1)) ? i + o + i : o)
                }
            }, l.RECORD_SEP = "\x1e", l.UNIT_SEP = "\x1f", l.BYTE_ORDER_MARK = "\uFEFF", l.BAD_DELIMITERS = ["\r", "\n", '"', l.BYTE_ORDER_MARK], l.WORKERS_SUPPORTED = !o && !!r.Worker, l.NODE_STREAM_INPUT = 1, l.LocalChunkSize = 10485760, l.RemoteChunkSize = 5242880, l.DefaultDelimiter = ",", l.Parser = f, l.ParserHandle = p, l.NetworkStreamer = c, l.FileStreamer = u, l.StringStreamer = g, l.ReadableStreamStreamer = d, r.jQuery && ((t = r.jQuery).fn.parse = function(e) {
                var o = e.config || {},
                    n = [];
                return this.each(function(e) {
                    if (!("INPUT" === t(this).prop("tagName").toUpperCase() && "file" === t(this).attr("type").toLowerCase() && r.FileReader) || !this.files || 0 === this.files.length) return !0;
                    for (var a = 0; a < this.files.length; a++) n.push({
                        file: this.files[a],
                        inputElem: this,
                        instanceConfig: t.extend({}, o)
                    })
                }), a(), this;

                function a() {
                    if (0 === n.length) k(e.complete) && e.complete();
                    else {
                        var r, o, a, s = n[0];
                        if (k(e.before)) {
                            var c = e.before(s.file, s.inputElem);
                            if ("object" == typeof c) {
                                if ("abort" === c.action) return r = s.file, o = s.inputElem, a = c.reason, void(k(e.error) && e.error({
                                    name: "AbortError"
                                }, r, o, a));
                                if ("skip" === c.action) return void i();
                                "object" == typeof c.config && (s.instanceConfig = t.extend(s.instanceConfig, c.config))
                            } else if ("skip" === c) return void i()
                        }
                        var u = s.instanceConfig.complete;
                        s.instanceConfig.complete = function(e) {
                            k(u) && u(e, s.file, s.inputElem), i()
                        }, l.parse(s.file, s.instanceConfig)
                    }
                }

                function i() {
                    n.splice(0, 1), a()
                }
            }), n && (r.onmessage = function(e) {
                e = e.data, void 0 === l.WORKER_ID && e && (l.WORKER_ID = e.workerId), "string" == typeof e.input ? r.postMessage({
                    workerId: l.WORKER_ID,
                    results: l.parse(e.input, e.config),
                    finished: !0
                }) : (r.File && e.input instanceof File || e.input instanceof Object) && (e = l.parse(e.input, e.config)) && r.postMessage({
                    workerId: l.WORKER_ID,
                    results: e,
                    finished: !0
                })
            }), (c.prototype = Object.create(s.prototype)).constructor = c, (u.prototype = Object.create(s.prototype)).constructor = u, (g.prototype = Object.create(g.prototype)).constructor = g, (d.prototype = Object.create(s.prototype)).constructor = d, l
        }, "function" == typeof e && e.amd ? e([], n) : r.exports = n()
    }, {}],
    "9KUoU": [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        o.defineInteropFlag(r), o.export(r, "waitUserDelay", () => l), o.export(r, "humanDelay", () => s), o.export(r, "occasionalLongPause", () => c), o.export(r, "performHumanNoise", () => u), o.export(r, "humanClick", () => d), o.export(r, "humanTypeText", () => x), o.export(r, "findGroupComposerField", () => E), o.export(r, "legacyTypeDescription", () => M);
        let n = (e, t) => Math.floor(e + Math.random() * (t - e + 1)),
            a = e => new Promise(t => setTimeout(t, e)),
            i = async () => {
                try {
                    let {
                        customInputDelaySeconds: e
                    } = await chrome.storage.local.get("customInputDelaySeconds"), t = Number(e);
                    if (!Number.isFinite(t) || t <= 0) return 0;
                    return 1e3 * Math.min(Math.max(t, 0), 10)
                } catch {
                    return 0
                }
            }, l = async () => {
                let e = await i();
                e > 0 && await a(e)
            }, s = async (e = 90, t = 300) => {
                await a(n(e, t))
            }, c = async (e = .12) => {
                Math.random() < e && await a(n(600, 1400))
            }, u = async e => {
                try {
                    let t = n(-5, 5),
                        r = n(-30, 30);
                    window.scrollBy({
                        left: t,
                        top: r,
                        behavior: "auto"
                    });
                    let o = Math.max(0, Math.min(window.innerWidth, Math.floor(window.innerWidth / 2 + n(-120, 120)))),
                        i = Math.max(0, Math.min(window.innerHeight, Math.floor(window.innerHeight / 2 + n(-120, 120)))),
                        l = n(1, 3);
                    for (let t = 0; t < l; t++) {
                        let t = new MouseEvent("mousemove", {
                            bubbles: !0,
                            clientX: o + n(-8, 8),
                            clientY: i + n(-8, 8)
                        });
                        (e || document.body)?.dispatchEvent(t), await a(n(20, 60))
                    }
                } catch {}
            }, g = async e => {
                try {
                    e.scrollIntoView({
                        block: "center",
                        inline: "center"
                    }), await s(60, 150)
                } catch {}
            }, d = async e => {
                if (!e) return;
                Math.random() < .35 && await u(e), await g(e);
                let t = e.getBoundingClientRect?.() || {
                        left: 0,
                        top: 0,
                        width: 0,
                        height: 0
                    },
                    r = Math.floor(t.left + Math.max(1, t.width * Math.random())),
                    o = Math.floor(t.top + Math.max(1, t.height * Math.random())),
                    i = t => e.dispatchEvent(new MouseEvent(t, {
                        bubbles: !0,
                        cancelable: !0,
                        view: window,
                        clientX: r,
                        clientY: o,
                        buttons: 1
                    }));
                i("pointerover"), await a(n(10, 40)), i("mouseover"), await a(n(10, 40)), i("pointerdown"), i("mousedown"), await a(n(40, 120)), e.focus?.(), await a(n(30, 90)), i("pointerup"), i("mouseup"), await a(n(20, 80)), i("click"), await s(), await c(.08)
            }, p = e => !!e && !0 === e.isContentEditable, m = e => {
                if (!e) return null;
                if (p(e) || "INPUT" === e.tagName || "TEXTAREA" === e.tagName) return e;
                let t = e.querySelector?.('input, textarea, [contenteditable="true"]');
                if (t) return t;
                if ("LABEL" === e.tagName) {
                    let t = e.htmlFor;
                    if (t) {
                        let e = document.getElementById(t);
                        if (e) return e
                    }
                }
                return null
            }, f = (e, t) => {
                let {
                    set: r
                } = Object.getOwnPropertyDescriptor(e.__proto__, "value") || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value") || {};
                r ? r.call(e, t) : e.value = t, e.dispatchEvent(new Event("input", {
                    bubbles: !0
                }))
            }, h = e => {
                let t = document.createRange();
                t.selectNodeContents(e), t.collapse(!1);
                let r = window.getSelection();
                r?.removeAllRanges(), r?.addRange(t)
            }, y = (e, t, r) => {
                let o = new KeyboardEvent(e, {
                    bubbles: !0,
                    cancelable: !0,
                    key: t,
                    code: 1 === t.length ? `Key${t.toUpperCase()}` : t
                });
                r.dispatchEvent(o)
            }, w = (e, t) => {
                let r = new InputEvent("beforeinput", {
                    bubbles: !0,
                    cancelable: !0,
                    data: t,
                    inputType: "insertText"
                });
                e.dispatchEvent(r)
            }, b = (e, t) => {
                let r = new InputEvent("input", {
                    bubbles: !0,
                    cancelable: !1,
                    data: t,
                    inputType: "insertText"
                });
                e.dispatchEvent(r)
            }, A = (e, t) => {
                if (void 0 !== e.value && "INPUT" === e.tagName || void 0 !== e.value && "TEXTAREA" === e.tagName) {
                    y("keydown", t, e), w(e, t), f(e, (e.value || "") + t), y("keyup", t, e);
                    return
                }
                if (p(e)) {
                    y("keydown", t, e), w(e, t);
                    let r = window.getSelection(),
                        o = r?.rangeCount ? r.getRangeAt(0) : document.createRange();
                    if (o) {
                        o.collapse(!1);
                        let e = document.createTextNode(t);
                        o.insertNode(e), o.setStartAfter(e), o.setEndAfter(e), r?.removeAllRanges(), r?.addRange(o)
                    } else e.appendChild(document.createTextNode(t)), h(e);
                    b(e, t), y("keyup", t, e);
                    return
                }
            }, k = async e => {
                await d(e), e.focus(), p(e) && h(e), await s(20, 60)
            }, x = async (e, t, r) => {
                try {
                    let o = m(e) || e,
                        i = o && (m(o) || o);
                    if (!i) return;
                    await k(i), await c(.02);
                    let s = Array.from((t ?? "").toString()),
                        u = Math.max(5, r?.perCharMinMs ?? 40),
                        g = Math.max(u, r?.perCharMaxMs ?? 120),
                        d = Math.max(0, Math.min(1, r?.longPauseProbability ?? .12));
                    for (let e = 0; e < s.length; e++) {
                        let t = s[e];
                        A(i, t), await a(n(u, g)), e > 0 && e % n(7, 14) == 0 && await c(d)
                    }
                    await l()
                } catch {}
            }, C = '[role="dialog"] [role="textbox"][contenteditable="true"]', v = [C, '[contenteditable="true"][aria-label="Create a public post\u2026"]', '[contenteditable="true"][aria-label="Create a public post..."]', '[contenteditable="true"][aria-label="Create a public post"]', '[contenteditable="true"][aria-label="Create post\u2026"]', '[contenteditable="true"][aria-label="Create post..."]', '[contenteditable="true"][aria-label="Create post"]', '[contenteditable="true"][aria-label="Create a post"]', '[contenteditable="true"][aria-label*="What\'s on your mind" i]', '[contenteditable="true"][role="textbox"]', '[role="textbox"][contenteditable="true"]', '[contenteditable="true"][aria-multiline="true"]', '[contenteditable="true"][data-lexical-editor]', '[contenteditable="true"][data-contents="true"]'], T = ['[aria-label="Create a public post"]', '[aria-label="Create a public post\u2026"]', '[aria-label="Create a public post..."]', '[aria-label="Create post"]', '[aria-label="Create post\u2026"]', '[aria-label="Create post..."]', '[aria-label="Create a post"]', '[aria-label*="Create post" i]', '[aria-label*="Create a post" i]'], _ = e => {
                if (!e) return !1;
                let t = e.getClientRects();
                return t.length > 0 && t[0].width > 0 && t[0].height > 0
            }, E = () => {
                let e = document.querySelector(C);
                if (e && _(e)) return e;
                for (let e of v) {
                    let t = Array.from(document.querySelectorAll(e)),
                        r = t.find(e => e && _(e) && e.isContentEditable);
                    if (r) return r
                }
                for (let e of T) {
                    let t = document.querySelector(e);
                    if (t && _(t)) {
                        let e = Array.from(t.querySelectorAll('[contenteditable="true"]')).find(e => _(e));
                        if (e) return e
                    }
                }
                let t = Array.from(document.querySelectorAll('[contenteditable="true"]')),
                    r = t.find(e => e && _(e) && e.isContentEditable);
                if (r) return r;
                let o = document.activeElement;
                return o && o.isContentEditable ? o : null
            }, S = (e, t) => {
                if (!e) return !1;
                try {
                    e.focus();
                    let r = window.getSelection(),
                        o = document.createRange();
                    o.selectNodeContents(e), r?.removeAllRanges(), r?.addRange(o), document.execCommand("selectAll", !1, "");
                    let n = document.execCommand("insertText", !1, t);
                    return n || (o.deleteContents(), o.insertNode(document.createTextNode(t)), r?.removeAllRanges()), e.dispatchEvent(new Event("input", {
                        bubbles: !0
                    })), e.dispatchEvent(new Event("change", {
                        bubbles: !0
                    })), !0
                } catch (e) {
                    return console.error("legacyInsertText failed:", e), !1
                }
            }, M = async (e, t) => {
                try {
                    await d(e)
                } catch {}
                let r = S(e, t);
                if (!r) {
                    await x(e, t, {
                        perCharMinMs: 5,
                        perCharMaxMs: 15,
                        longPauseProbability: .01
                    });
                    return
                }
                await l()
            }
    }, {
        "@parcel/transformer-js/src/esmodule-helpers.js": "cHUbl"
    }]
}, ["eZj0B"], "eZj0B", "parcelRequire4d24"), globalThis.define = t;