var e, t;
"function" == typeof(e = globalThis.define) && (t = e, e = null),
function(t, r, o, a, n) {
    var i = "undefined" != typeof globalThis ? globalThis : "undefined" != typeof self ? self : "undefined" != typeof window ? window : "undefined" != typeof global ? global : {},
        l = "function" == typeof i[a] && i[a],
        s = l.cache || {},
        c = "undefined" != typeof module && "function" == typeof module.require && module.require.bind(module);

    function u(e, r) {
        if (!s[e]) {
            if (!t[e]) {
                var o = "function" == typeof i[a] && i[a];
                if (!r && o) return o(e, !0);
                if (l) return l(e, !0);
                if (c && "string" == typeof e) return c(e);
                var n = Error("Cannot find module '" + e + "'");
                throw n.code = "MODULE_NOT_FOUND", n
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
            return i[a]
        }
    }), i[a] = u;
    for (var g = 0; g < r.length; g++) u(r[g]);
    if (o) {
        var d = u(o);
        "object" == typeof exports && "undefined" != typeof module ? module.exports = d : "function" == typeof e && e.amd ? e(function() {
            return d
        }) : n && (this[n] = d)
    }
}({
    kgW6q: [function(e, t, r) {
        e("../../../src/background/index")
    }, {
        "../../../src/background/index": "iqY5N"
    }],
    iqY5N: [function(e, t, r) {
        var o = e("~common/browserMethods"),
            a = e("~utils/ai_images"),
            n = e("~utils/helping");
        async function i(e) {
            let t = [];
            for (let r = 0; r < e.length; r++) try {
                let o = e[r];
                if (!o || "string" != typeof o) {
                    t.push("");
                    continue
                }
                let a = new AbortController,
                    n = setTimeout(() => a.abort(), 2e4),
                    i = await fetch(o, {
                        signal: a.signal,
                        headers: {
                            Accept: "image/webp,image/avif,image/*,*/*;q=0.8",
                            "Cache-Control": "no-cache"
                        }
                    });
                if (clearTimeout(n), !i.ok) throw Error(`HTTP ${i.status}`);
                let s = await i.blob();
                if (s.size > 8388608) {
                    t.push("");
                    continue
                }
                let c = await l(s);
                t.push(c)
            } catch {
                t.push("")
            }
            return t
        }

        function l(e) {
            return new Promise((t, r) => {
                let o = new FileReader;
                o.onloadend = () => t(o.result), o.onerror = r, o.readAsDataURL(e)
            })
        }
        async function s(e, t, r = !1) {
            let o = [];
            for (let n = 0; n < e.length; n++) {
                let i = e[n];
                if (!i || "string" != typeof i) {
                    o.push(null);
                    continue
                }
                try {
                    console.log(`bg: EDIT_IMAGES processing ${n+1}/${e.length}`, i.slice(0, 80));
                    let l = await (0, a.editImage)(i, t);
                    o.push(l), r && chrome.runtime.sendMessage({
                        type: "EDIT_PROGRESS",
                        current: n + 1,
                        total: e.length,
                        imageDataUrl: l
                    })
                } catch (e) {
                    console.error(`bg: Error processing image ${n+1}:`, e), o.push(null)
                }
            }
            return o
        }
        chrome.sidePanel.setPanelBehavior({
            openPanelOnActionClick: !0
        }),
        // Keep the free-tier backend awake while the browser runs: Render spins
        // the server down after ~15 idle minutes, so a 4-minute health ping
        // means Load Vehicles never hits a 45-second cold start mid-workday.
        chrome.alarms && (chrome.alarms.create("xk-keepalive", {
            periodInMinutes: 4
        }), chrome.alarms.onAlarm.addListener(async e => {
            if ("xk-keepalive" === e.name) try {
                let t = await chrome.storage.local.get("xk_backend"),
                    r = t && t.xk_backend;
                r && fetch(String(r).replace(/\/+$/, "") + "/api/health").catch(() => {})
            } catch (t) {}
        })), chrome.runtime.onMessage.addListener((e, t, r) => {
            let a = e?.message || e?.action || e?.type;
            switch (console.log("[BG] onMessage received:", a, "from:", t?.tab?.url?.substring(0, 50) || "extension"), a) {
                case "xkClosePostTab":
                    return (async () => {
                        try { t && t.tab && t.tab.id && await chrome.tabs.remove(t.tab.id) } catch (e) { console.warn("[Background] close post tab failed:", e) }
                    })(), !0;
                case "postToFacebook":
                    return (async () => {
                        try {
                            let t;
                            let r = await (0, n.getWhereToPostData)(),
                                {
                                    whereToPost: a,
                                    facebookGroup: i
                                } = r,
                                l = await (0, n.getGroupUrl)(i);
                            "FB Marketplace" === a && (t = "https://www.facebook.com/marketplace/create/vehicle"), "FB Groups" === a && (t = l), "FB Page" === a && (t = "https://www.facebook.com/");
                            let s = await chrome.storage.local.get(),
                                c = (0, o.cleanLocalStorageObject)(s);
                            {
                                // Posts go to a dedicated UNFOCUSED posting window
                                // (default), or to a fresh foreground tab when the
                                // panel's toggle says In Front (newTab === false).
                                let d = null;
                                if (e && !1 === e.newTab) d = await chrome.tabs.create({
                                    url: t,
                                    active: !0
                                });
                                else try {
                                    let w = await chrome.storage.local.get("xk_post_win"),
                                        p = w && w.xk_post_win;
                                    if (p) try {
                                        await chrome.windows.get(p)
                                    } catch (x) {
                                        p = null
                                    }
                                    if (p) d = await chrome.tabs.create({
                                        windowId: p,
                                        url: t,
                                        active: !0
                                    });
                                    else {
                                        let m = await chrome.windows.create({
                                            url: t,
                                            focused: !1,
                                            width: 1150,
                                            height: 900
                                        });
                                        await chrome.storage.local.set({
                                            xk_post_win: m.id
                                        }), d = m.tabs && m.tabs[0], d || (d = (await chrome.tabs.query({
                                            windowId: m.id
                                        }))[0])
                                    }
                                } catch (x) {
                                    console.warn("[Background] posting window failed, falling back to tab:", x), d = await chrome.tabs.create({
                                        url: t,
                                        active: !0
                                    })
                                }
                                for (let u = 0; u < 120; u++) {
                                    let g = await chrome.tabs.get(d.id).catch(() => null);
                                    if (g && "complete" === g.status) break;
                                    await (0, o.asyncSleep)(.5)
                                }
                                await (0, o.asyncSleep)(1), await chrome.tabs.sendMessage(d.id, {
                                    message: "runFBScript",
                                    vehicle: e?.vehicle,
                                    localStorage: c,
                                    whereToPost: a
                                })
                            }
                        } catch (e) {
                            console.error("[Background] postToFacebook error:", e)
                        }
                    })(), !0;
                case "SET_BLOB_FROM_URL": {
                    let {
                        imageUrl: t
                    } = e.data, a = !1, n = setTimeout(() => {
                        a || (a = !0, r({
                            success: !1,
                            error: "Background script timeout"
                        }))
                    }, 32e3);
                    return (0, o.getBlobFromImgUrl)(t).then(e => {
                        clearTimeout(n), a || ((0, o.setBlobStorage)(e), a = !0, r({
                            success: !0
                        }))
                    }).catch(e => {
                        clearTimeout(n), a || (console.error("[Background] Error processing image:", t?.substring(0, 50) + "...", e.message || e), a = !0, r({
                            success: !1,
                            error: e.message || String(e)
                        }))
                    }), !0
                }
                case "openSidepanel":
                    return (async () => {
                        try {
                            await chrome.sidePanel.open({
                                windowId: t.tab.windowId
                            })
                        } catch (e) {
                            console.error("[Background] openSidepanel error:", e)
                        }
                    })(), !0;
                case "AI_DESCRIPTION_GENERATION": {
                    let {
                        textForPost: t,
                        MileageValue: a
                    } = e?.data;
                    return (0, o.AIDescription)(t, a).then(e => {
                        r({
                            success: "true",
                            data: e
                        })
                    }), !0
                }
                case "FETCH_IMAGES_FROM_URLS":
                    return i(e.imageUrls).then(e => {
                        r({
                            success: !0,
                            data: e
                        })
                    }).catch(e => {
                        r({
                            success: !1,
                            error: e?.message || String(e)
                        })
                    }), !0;
                case "EDIT_IMAGES": {
                    let {
                        imageUrls: t,
                        prompt: o
                    } = e || {};
                    if (!Array.isArray(t) || 0 === t.length) return r({
                        success: !1,
                        error: "No image URLs provided"
                    }), !0;
                    return (async () => {
                        try {
                            let e = await s(t, o, !0);
                            r({
                                success: !0,
                                processedUrls: e
                            })
                        } catch (e) {
                            console.error("bg: EDIT_IMAGES failed", e), r({
                                success: !1,
                                error: e?.message || String(e)
                            })
                        }
                    })(), !0
                }
                default:
                    return
            }
        }), chrome.runtime.onInstalled.addListener(() => {
            chrome.storage.local.set({
                emoji: '"\uD83E\uDD18"'
            }), chrome.storage.local.set({
                mileUnit: '"Miles"'
            }), chrome.storage.local.set({
                vehicleCategory: '"Other"'
            }), chrome.storage.local.set({
                filterOptions: '"Title"'
            }), chrome.storage.local.set({
                whereToPost: '"FB Marketplace"'
            })
        }), chrome.storage.onChanged.addListener((e, t) => {
            if ("local" !== t || !e._imgReq?.newValue) return;
            let {
                id: r,
                url: o
            } = e._imgReq.newValue;
            r && o && (console.log("[BG] Storage fetch request:", r, o.substring(0, 60)), chrome.storage.local.remove("_imgReq"), (async () => {
                let e = `_imgRes_${r}`;
                try {
                    let t = new AbortController,
                        a = setTimeout(() => t.abort(), 2e4),
                        n = await fetch(o, {
                            signal: t.signal,
                            headers: {
                                Accept: "image/webp,image/avif,image/*,*/*;q=0.8",
                                "Cache-Control": "no-cache"
                            }
                        });
                    if (clearTimeout(a), !n.ok) throw Error(`HTTP ${n.status}`);
                    let i = await n.blob();
                    if (i.size > 8388608) {
                        await chrome.storage.local.set({
                            [e]: ""
                        });
                        return
                    }
                    let s = await l(i);
                    await chrome.storage.local.set({
                        [e]: s
                    }), console.log("[BG] Storage fetch complete:", r)
                } catch (t) {
                    console.error("[BG] Storage fetch failed:", r, t?.message || t), await chrome.storage.local.set({
                        [e]: ""
                    })
                }
            })())
        })
    }, {
        "~common/browserMethods": "7ZVwc",
        "~utils/ai_images": "gdHq6",
        "~utils/helping": "lPT9I"
    }],
    "7ZVwc": [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        o.defineInteropFlag(r), o.export(r, "isVinPresent", () => R), o.export(r, "updateSoldVehiclesWithPresence", () => D), o.export(r, "AIDescription", () => I), o.export(r, "preparePromptForOpenAI", () => F), o.export(r, "cleanLocalStorageObject", () => $), o.export(r, "postToFbMarketplace", () => M), o.export(r, "updateActiveTabUrl", () => x), o.export(r, "updateCurrentPageUrl", () => A), o.export(r, "setLocalStorage", () => m), o.export(r, "getLocalStorage", () => f), o.export(r, "tabMessage", () => w), o.export(r, "runTimeMessage", () => b), o.export(r, "setBlobStorage", () => h), o.export(r, "getBlogStorage", () => y), o.export(r, "getBlobFromImgUrl", () => p), o.export(r, "asyncSleep", () => O);
        var a = e("webextension-polyfill"),
            n = o.interopDefault(a),
            i = e("~imagesUpload/images"),
            l = e("~utils/ai"),
            s = e("~utils/aiAttributes"),
            c = e("~utils/humanInteraction");
        let u = "social_auto_group",
            g = n.default.storage.local;
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
                let a = await o.blob();
                if (a.size > 26214400) throw Error(`Image size exceeds 25 MB for ${e}`);
                return await d(a)
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
            let t = await (0, n.default).tabs.query({
                active: !0
            });
            return await (0, n.default).tabs.sendMessage(t[0].id, {
                ...e
            })
        }
        async function b(e) {
            try {
                let t = await (0, n.default).runtime.sendMessage(e);
                return t
            } catch (e) {
                throw console.error("Runtime message error:", e), e
            }
        }
        async function A(e) {
            let t = await (0, n.default).tabs.query({
                active: !0
            });
            (0, n.default).tabs.update(t[0].id, {
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
            let t = await (0, n.default).tabs.query({
                active: !0
            });
            await (0, n.default).tabs.update(t[0]?.id, {
                url: e
            }), await T(t[0]?.id)
        }
        let C = (e, t) => {
            try {
                let r = Array.from(document.querySelectorAll(e));
                return r?.find(e => e instanceof HTMLElement && e?.innerText.trim() === t)
            } catch (e) {
                return console.error("Error finding element:", e), null
            }
        };
        async function T(e) {
            await O(.5);
            let t = await (0, n.default).tabs.get(e);
            if ("loading" != t.status) return e;
            await T(e)
        }
        let v = e => {
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
            E = (e, t) => {
                let r = "TEXTAREA" === e.tagName ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
                    o = Object.getOwnPropertyDescriptor(r, "value")?.set;
                o ? o.call(e, t) : e.value = t, e.dispatchEvent(new Event("input", {
                    bubbles: !0
                })), e.dispatchEvent(new Event("change", {
                    bubbles: !0
                }))
            },
            _ = async (e, t) => {
                if (!e) return;
                let r = v(e);
                r ? (await O(.4 + .5 * Math.random()), r.focus(), await O(.3 + .4 * Math.random()), E(r, t), await O(.5 + .7 * Math.random())) : (e?.focus(), document.execCommand("insertText", !1, t))
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
            let r, o, a, u, g;
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
                Trim: T,
                ExteriorColor: v,
                InteriorColor: E,
                BodyStyle: M,
                Drivetrain: I,
                engine: $,
                StateofVehicle: F,
                HardcodedDescription: D
            } = e;
            console.log("[Marketplace] HardcodedDescription:", D), console.log(e, "vehicle");
            let R = "Seller Notes: ",
                U = "",
                L = {
                    body_style: "Other",
                    exterior_color: "Black",
                    interior_color: "Black",
                    fuel_type: "Gasoline"
                },
                P = "";
            T && (U = T);
            let N = C("label", "Vehicle type");
            await S('[aria-label="Preview"]', 3e4, 500);
            let B = e.OriginalDescription || "",
                j = B;
            j && "" !== j.trim() || (j = h);
            let q = `Year: ${m}
Make: ${d}
Model: ${p}
Trim: ${U||"Not specified"}
Price: ${f}
Mileage: ${A}
VIN: ${b}
Stock Number: ${y||"Not specified"}
Exterior Color: ${v||"Not specified"}
Interior Color: ${E||"Not specified"}
Body Style: ${M||"Not specified"}
Drivetrain: ${I||"Not specified"}
Engine: ${$||"Not specified"}
Title: ${h}
StateofVehicle: ${F||"Not specified"}
Description: ${j||"Not provided"}`;
            t && (r = t.vehicleCategory, u = t.shouldAddStockNumber, g = t.isAiDescription, R = t.description), R || (R = ".");
            let G = await (0, n.default).storage.local.get("emoji");
            a = G.emoji?.replace(/\"/g, "") || "";
            let V = await (0, n.default).storage.local.get("mileUnit");
            o = V.mileUnit?.replace(/\"/g, "") || "Miles";
            let z = !0 === g || "true" === g,
                H = `${m} ${d} ${p} ${U} for Sale

Looking for a great ${d}? Check out this ${m} ${d} ${p}!

- Price: ${f}
- Mileage: ${A}
- VIN: ${b}
- Stock Number: ${y||"N/A"}
${v?`- Exterior Color: ${v}`:""}
${E?`- Interior Color: ${E}`:""}
${$?`- Engine: ${$}`:""}
${I?`- Drivetrain: ${I}`:""}

Contact us for more information or to schedule a test drive!`;
            if (z) try {
                (P = await (0, l.generateAIDescription)(q)) && "" !== P.trim() || (console.warn("[Marketplace] AI description was empty, using fallback"), P = H)
            } catch (e) {
                console.error("[Marketplace] Error generating AI description:", e), P = H
            } else P = function(e) {
                let t = e?.replace(/[\u00ae$&*()@]/g, "")?.replace(/(===+|----+)/g, "")?.replace(/\u00A0/g, " ")?.replace(/\s+/g, " ")?.trim(),
                    r = t?.replace(/,\s*/g, ",\n")?.replace(/:\s*/g, ":\n")?.replace(/\.\s*/g, ".\n")?.replace(/\*\s*/g, "\n* ")?.replace(/======/g, "\n======")?.replace(/\s+======/g, "\n======");
                return r
            }(B || "") || H;
            try {
                await (0, c.humanClick)(N), await O(.5);
                let e = C("span", k(r) || "Other");
                await (0, c.humanClick)(e), await (0, c.waitUserDelay)()
            } catch (e) {
                console.error("[Marketplace] Error selecting vehicle type:", e)
            }
            try {
                let e = C("label", "Year");
                await (0, c.humanClick)(e), await O(.5);
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
                    e && (L = {
                        body_style: e.body_style || L.body_style,
                        exterior_color: e.exterior_color || L.exterior_color,
                        interior_color: e.interior_color || L.interior_color,
                        fuel_type: e.fuel_type || L.fuel_type
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
                        a = null,
                        n = null;
                    for (let t = 0; t < 10; t++) {
                        await O(.2);
                        let r = "true" === e.getAttribute("aria-expanded");
                        if (r && !n && (n = e.getAttribute("aria-controls"), console.log("[Car/Truck] Make label expanded, aria-controls:", n)), n && (a = document.getElementById(n))) {
                            o = !0, console.log("[Car/Truck] Make dropdown found by aria-controls at attempt", t + 1, "Element:", a);
                            break
                        }
                        let i = e.closest("form") || e.parentElement?.parentElement;
                        if (i) {
                            let e = i.querySelector('[role="listbox"], [role="menu"]');
                            if (e) {
                                let r = e.querySelectorAll("span").length > 0;
                                if (r) {
                                    a = e, o = !0, console.log("[Car/Truck] Make dropdown found near label at attempt", t + 1, "Element:", a);
                                    break
                                }
                            }
                        }
                        if (!a) {
                            let e = document.querySelector('[role="listbox"], [role="menu"]');
                            if (e) {
                                a = e, o = !0, console.warn("[Car/Truck] Found generic dropdown (may be wrong one) at attempt", t + 1, "Element:", a);
                                break
                            }
                        }
                        4 === t && console.log("[Car/Truck] Still waiting for Make dropdown (attempt 5/10)...")
                    }
                    if (o || console.warn("[Car/Truck] Make dropdown may not have opened, continuing anyway..."), a) {
                        let e = a.querySelectorAll("span"),
                            t = Array.from(e).map(e => e.textContent?.trim());
                        console.log("[Car/Truck] Available Make options in dropdown:", t.slice(0, 20))
                    }
                    let i = null;
                    if (a) {
                        let e = a.querySelectorAll("span");
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
                        if (console.log("[Car/Truck] Make option not found, waiting 0.3s and retrying..."), await O(.3), a) {
                            let e = a.querySelectorAll("span");
                            (i = Array.from(e).find(e => e instanceof HTMLElement && e.textContent?.trim() === r)) || (i = Array.from(e).find(e => e instanceof HTMLElement && e.textContent?.trim().toLowerCase() === r.toLowerCase()))
                        }
                        i || (i = C("span", r)), console.log("[Car/Truck] Second search for Make option:", i ? "FOUND" : "NOT FOUND", r, i ? `(Found: "${i.textContent?.trim()}")` : "")
                    }
                    if (i) console.log("[Car/Truck] Make option found, clicking:", r, "Element:", i, "Text:", i.textContent), await (0, c.humanClick)(i), await O(.3), console.log("[Car/Truck] Clicked Make option, waiting for selection to register...");
                    else {
                        console.warn(`[Car/Truck] Make option '${r}' not found, trying fallback 'Toyota'`);
                        let e = C("span", "Toyota");
                        if (e) console.log("[Car/Truck] Fallback Make 'Toyota' found, clicking:", e.textContent), await (0, c.humanClick)(e), await O(.3);
                        else throw console.error("[Car/Truck] Neither target nor fallback Make option found!"), Error("Neither target nor fallback Make option found")
                    }
                    await (0, c.waitUserDelay)(), console.log("[Car/Truck] Make selection completed successfully"), console.log("=== [Car/Truck] Make Selection Complete ===")
                } catch (e) {
                    console.error("[Car/Truck] Error selecting Make:", e instanceof Error ? e.message : e, e), console.error("[Car/Truck] Stack trace:", e instanceof Error ? e.stack : "N/A")
                }
                try {
                    let e = C("label", "Vehicle condition");
                    await (0, c.humanClick)(e), await O(.5);
                    let t = C("span", "Excellent");
                    await (0, c.humanClick)(t), await (0, c.waitUserDelay)()
                } catch (e) {
                    console.error("[Car/Truck] Error selecting vehicle condition:", e)
                }
                try {
                    let e = C("label", "Mileage"),
                        t = "string" == typeof A ? A.replace(",", "") : A?.toString() || "0";
                    await _(e, k(t) || "0")
                } catch (e) {
                    console.error("[Car/Truck] Error entering mileage:", e)
                }
                console.log("=== [Car/Truck] Starting Exterior Color Selection ==="), console.log("[Car/Truck] Target exterior color:", L?.exterior_color || "Black"), console.log("[Car/Truck] Full vehicleAttributes:", JSON.stringify(L, null, 2));
                try {
                    console.log("[Car/Truck] Searching for 'Exterior color' label...");
                    let e = C("label", "Exterior color");
                    if (!e) throw console.error("[Car/Truck] Exterior color label not found"), console.error("[Car/Truck] Available labels on page:", Array.from(document.querySelectorAll("label")).map(e => e.textContent)), Error("Exterior color label element not found");
                    console.log("[Car/Truck] Exterior color label found:", e.textContent, "Element:", e), console.log("[Car/Truck] Clicking exterior color label, target color:", L?.exterior_color || "Black"), console.log("[Car/Truck] Closing any open dropdowns before opening exterior color...");
                    let t = document.querySelectorAll('[aria-expanded="true"][role="combobox"]');
                    if (t.length > 0) {
                        console.log("[Car/Truck] Found", t.length, "open dropdown(s), closing them...");
                        let e = document.body;
                        e && (e.click(), await O(.2))
                    }
                    await (0, c.humanClick)(e), console.log("[Car/Truck] Clicked exterior color label, waiting for dropdown...");
                    let r = !1,
                        o = null,
                        a = null;
                    for (let t = 0; t < 10; t++) {
                        await O(.2);
                        let n = "true" === e.getAttribute("aria-expanded");
                        if (n && !a && (a = e.getAttribute("aria-controls"), console.log("[Car/Truck] Exterior color label expanded, aria-controls:", a)), a && (o = document.getElementById(a))) {
                            r = !0, console.log("[Car/Truck] Exterior color dropdown found by aria-controls at attempt", t + 1, "Element:", o);
                            break
                        }
                        let i = e.closest("form") || e.parentElement?.parentElement;
                        if (i) {
                            let e = i.querySelector('[role="listbox"], [role="menu"]');
                            if (e) {
                                let a = e.querySelectorAll("span").length > 0;
                                if (a) {
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
                    let n = L?.exterior_color || "Black";
                    if (console.log("[Car/Truck] Looking for exterior color option with text:", n), o) {
                        let e = o.querySelectorAll("span"),
                            t = Array.from(e).map(e => e.textContent?.trim());
                        console.log("[Car/Truck] Available exterior color options in dropdown:", t)
                    }
                    let i = null;
                    if (o) {
                        let e = o.querySelectorAll("span");
                        i = Array.from(e).find(e => e instanceof HTMLElement && e.textContent?.trim() === n), console.log("[Car/Truck] First search for exterior color option in dropdown:", i ? "FOUND" : "NOT FOUND", n)
                    }
                    if (i || (console.log("[Car/Truck] Exterior color option not found in dropdown, searching entire document..."), i = C("span", n), console.log("[Car/Truck] Search in entire document:", i ? "FOUND" : "NOT FOUND", n)), !i) {
                        if (console.log("[Car/Truck] Exterior color option not found, waiting 0.3s and retrying..."), await O(.3), o) {
                            let e = o.querySelectorAll("span");
                            i = Array.from(e).find(e => e instanceof HTMLElement && e.textContent?.trim() === n)
                        }
                        i || (i = C("span", n)), console.log("[Car/Truck] Second search for exterior color option:", i ? "FOUND" : "NOT FOUND", n)
                    }
                    if (i) console.log("[Car/Truck] Exterior color option found, clicking:", n, "Element:", i, "Text:", i.textContent), await (0, c.humanClick)(i), await O(.3), console.log("[Car/Truck] Clicked exterior color option, waiting for selection to register...");
                    else {
                        console.warn(`[Car/Truck] Exterior color option '${n}' not found after retry, trying fallback 'Black'`);
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
                    await (0, c.humanClick)(e), await O(.5);
                    let t = C("span", L?.body_style || "Other");
                    if (t) await (0, c.humanClick)(t);
                    else {
                        console.warn("[Car/Truck] Body style option not found, trying fallback 'Other'");
                        let e = C("span", "Other");
                        e && await (0, c.humanClick)(e)
                    }
                    await (0, c.waitUserDelay)()
                } catch (e) {
                    console.error("[Car/Truck] Error selecting body style:", e)
                }
                try {
                    let e = C("label", "Fuel type");
                    await (0, c.humanClick)(e), await O(.5);
                    let t = C("span", L?.fuel_type || "Gasoline");
                    if (t) await (0, c.humanClick)(t);
                    else {
                        console.warn("[Car/Truck] Fuel type option not found, trying fallback 'Gasoline'");
                        let e = C("span", "Gasoline");
                        e && await (0, c.humanClick)(e)
                    }
                    await (0, c.waitUserDelay)()
                } catch (e) {
                    console.error("[Car/Truck] Error selecting fuel type:", e)
                }
                console.log("=== [Car/Truck] Starting Interior Color Selection ==="), console.log("[Car/Truck] Target interior color:", L?.interior_color || "Black"), console.log("[Car/Truck] Full vehicleAttributes at interior color step:", JSON.stringify(L, null, 2));
                try {
                    console.log("[Car/Truck] Searching for 'Interior color' label...");
                    let e = C("label", "Interior color");
                    if (!e) throw console.error("[Car/Truck] Interior color label not found"), console.error("[Car/Truck] Available labels on page:", Array.from(document.querySelectorAll("label")).map(e => e.textContent)), Error("Interior color label element not found");
                    console.log("[Car/Truck] Interior color label found:", e.textContent, "Element:", e), console.log("[Car/Truck] Clicking interior color label, target color:", L?.interior_color || "Black"), console.log("[Car/Truck] Closing any open dropdowns before opening interior color...");
                    let t = document.querySelectorAll('[aria-expanded="true"][role="combobox"]');
                    if (t.length > 0) {
                        console.log("[Car/Truck] Found", t.length, "open dropdown(s), closing them...");
                        let e = document.body;
                        e && (e.click(), await O(.2))
                    }
                    await (0, c.humanClick)(e), console.log("[Car/Truck] Clicked interior color label, waiting for dropdown...");
                    let r = !1,
                        o = null,
                        a = null;
                    for (let t = 0; t < 10; t++) {
                        await O(.2);
                        let n = "true" === e.getAttribute("aria-expanded");
                        if (n && !a && (a = e.getAttribute("aria-controls"), console.log("[Car/Truck] Interior color label expanded, aria-controls:", a)), a && (o = document.getElementById(a))) {
                            r = !0, console.log("[Car/Truck] Interior color dropdown found by aria-controls at attempt", t + 1, "Element:", o);
                            break
                        }
                        let i = e.closest("form") || e.parentElement?.parentElement;
                        if (i) {
                            let e = i.querySelector('[role="listbox"], [role="menu"]');
                            if (e) {
                                let a = e.querySelectorAll("span").length > 0;
                                if (a) {
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
                    let n = L?.interior_color || "Black";
                    if (console.log("[Car/Truck] Looking for interior color option with text:", n), o) {
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
                        i = Array.from(e).find(e => e instanceof HTMLElement && e.textContent?.trim() === n), console.log("[Car/Truck] First search for interior color option in dropdown:", i ? "FOUND" : "NOT FOUND", n), i && console.log("[Car/Truck] Found interior color option element:", i, "Text:", i.textContent, "Parent:", i.parentElement)
                    }
                    if (i || (console.log("[Car/Truck] Interior color option not found in dropdown, searching entire document..."), i = C("span", n), console.log("[Car/Truck] Search in entire document:", i ? "FOUND" : "NOT FOUND", n)), !i) {
                        if (console.log("[Car/Truck] Interior color option not found, waiting 0.3s and retrying..."), await O(.3), o) {
                            let e = o.querySelectorAll("span");
                            i = Array.from(e).find(e => e instanceof HTMLElement && e.textContent?.trim() === n)
                        }
                        i || (i = C("span", n)), console.log("[Car/Truck] Second search for interior color option:", i ? "FOUND" : "NOT FOUND", n), i && console.log("[Car/Truck] Found interior color option on retry:", i.textContent)
                    }
                    if (i) {
                        console.log("[Car/Truck] Interior color option found, clicking:", n, "Element:", i, "Text:", i.textContent, "Is visible:", "none" !== window.getComputedStyle(i).display), await (0, c.humanClick)(i), await O(.3), console.log("[Car/Truck] Clicked interior color option, waiting for selection to register..."), await O(.2);
                        let t = e.textContent || "";
                        console.log("[Car/Truck] Interior color label text after selection:", t)
                    } else {
                        console.warn(`[Car/Truck] Interior color option '${n}' not found after retry, trying fallback 'Black'`);
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
                W = `${p} ${U} ${a}`
            } else if ("Motorcycle" === r) {
                try {
                    let e = await (0, s.extractAttributesFromDescription)(q);
                    e && (L = {
                        body_style: e.body_style || L.body_style,
                        exterior_color: e.exterior_color || L.exterior_color,
                        interior_color: e.interior_color || L.interior_color,
                        fuel_type: e.fuel_type || L.fuel_type
                    })
                } catch (e) {
                    console.error("[Motorcycle] Error extracting AI attributes:", e)
                }
                try {
                    let e = C("label", "Make");
                    await (0, c.humanClick)(e), await O(.5);
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
                    let e = C("label", "Exterior color");
                    await (0, c.humanClick)(e), await O(.5);
                    let t = C("span", L?.exterior_color || "Black");
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
                try {
                    let e = C("label", "Fuel type");
                    await (0, c.humanClick)(e), await O(.5);
                    let t = C("span", L?.fuel_type || "Gasoline");
                    if (t) await (0, c.humanClick)(t);
                    else {
                        console.warn("[Motorcycle] Fuel type option not found, trying fallback 'Gasoline'");
                        let e = C("span", "Gasoline");
                        e && await (0, c.humanClick)(e)
                    }
                    await (0, c.waitUserDelay)()
                } catch (e) {
                    console.error("[Motorcycle] Error selecting fuel type:", e)
                }
                try {
                    let e = C("label", "Mileage"),
                        t = "string" == typeof A ? A.replace(",", "") : A?.toString() || "0";
                    await _(e, k(t) || "0")
                } catch (e) {
                    console.error("[Motorcycle] Error entering mileage:", e)
                }
                W = `${p} ${U} ${a}`
            } else {
                try {
                    let e = C("label", "Make");
                    await _(e, k(d) || "n/a")
                } catch (e) {
                    console.error("[Other] Error entering Make:", e)
                }
                W = `${p} ${U} ${a} ${A||0} ${o}`
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
                console.log("[Marketplace] Model label found:", t.textContent, "Element:", t), await _(t, k(W) || "n/a"), console.log("[Marketplace] Model entry completed successfully"), console.log("=== [Marketplace] Model Entry Complete ===")
            } catch (e) {
                console.error("[Marketplace] Error entering Model:", e instanceof Error ? e.message : e, e)
            }
            try {
                let e = C("label", "Price");
                await _(e, k(f) || "n/a")
            } catch (e) {
                console.error("Error entering Price:", e)
            }
            try {
                let e = C("label", "Description"),
                    t = u ? `${P}
Stock Number: ${y}` : P;
                D && "string" == typeof D && "" !== D.trim() && (t = t.trimEnd() + "\n\n" + D.trim(), console.log("[Marketplace] Appended HardcodedDescription to final description")), await _(e, k(t) || "n/a")
            } catch (e) {
                console.error("Error entering Description:", e)
            }
            try {
                let e = Array.isArray(x) ? x.slice(0, 20) : [];
                await (0, i.uploadImagesToFacebook)(e)
            } catch (e) {
                console.error("Error uploading images:", e)
            }
        }
        async function I(e, t) {
            let r = "",
                o = await F(e, t);
            o = o.replaceAll("title:", "description").replaceAll("title", "description").replaceAll("Title:", "description").replaceAll("Title", "description").replaceAll("TITLE", "description");
            let a = await (0, n.default).storage.local.get("password"),
                i = a.password?.replace(/\"/g, "") || "",
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

        function $(e) {
            return {
                emoji: e?.emoji?.replace(/\"/g, ""),
                imageBlog: e?.imageBlog,
                isAuthenticated: e?.isAuthenticated === "true",
                mileUnit: e?.mileUnit?.replace(/\"/g, ""),
                password: e?.password?.replace(/\"/g, ""),
                shouldAddStockNumber: e?.shouldAddStockNumber === "true",
                vehicleCategory: e?.vehicleCategory?.replace(/\"/g, ""),
                description: e?.description?.replace(/\"/g, ""),
                whereToPost: e?.whereToPost?.replace(/\"/g, ""),
                isAiDescription: e?.isAiDescription === "true"
            }
        }
        async function F(e, t) {
            try {
                let {
                    shouldAddInstructions: r
                } = await (0, n.default).storage.local.get("shouldAddInstructions"), o = `Here is the vehicle information:
${e} Mileage: ${t}

Please write a simple, magazine-style article description for this vehicle. **Start with the year, make, and model**, then state the current mileage. **Highlight key features** that make this vehicle stand out. Keep it concise and engaging. Do not use any special characters or include the dealership name. Aim for about 80\u2013120 words.`;
                if ("true" === r) {
                    let {
                        description: e
                    } = await (0, n.default).storage.local.get("description"), t = e?.replace(/"/g, "");
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

        function D(e, t, r) {
            let o = new Map;
            t?.forEach(e => {
                e?.VIN && o.set(e.VIN, e)
            });
            let a = e => {
                    if (!e) return e;
                    let t = e.replace(/[^\d.-]/g, ""),
                        r = parseFloat(t);
                    return isNaN(r) ? e : `$${r.toLocaleString()}`
                },
                n = (e, t) => {
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
                    let n = e => "string" != typeof e ? e : e.replace(/[^\d.-]/g, ""),
                        i = n(r),
                        l = n(o),
                        s = i !== l;
                    return {
                        priceChanged: s,
                        newPrice: s ? a(o) : null,
                        oldPrice: s ? a(r) : null
                    }
                };
            return r ? e?.map(e => {
                let t = o.get(e?.vin),
                    r = n(e, t);
                return {
                    ...e,
                    present: o.has(e?.vin),
                    ...r
                }
            })?.filter(e => !o.has(e?.vin)) : e?.map(e => {
                let t = o.get(e?.vin),
                    r = n(e, t);
                return {
                    ...e,
                    present: o.has(e?.vin),
                    ...r
                }
            })
        }

        function R(e, t) {
            return t?.some(t => t?.vin === e)
        }
    }, {
        "webextension-polyfill": "5lhhz",
        "~imagesUpload/images": "kPpVM",
        "~utils/ai": "2tucF",
        "~utils/aiAttributes": "7eKeW",
        "~utils/humanInteraction": "gF6Nj",
        "@parcel/transformer-js/src/esmodule-helpers.js": "hbR2Q"
    }],
    "5lhhz": [function(t, r, o) {
        var a;
        "undefined" != typeof globalThis ? globalThis : "undefined" != typeof self && self, a = function(e) {
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
                    a = (t, r) => (...o) => {
                        e.runtime.lastError ? t.reject(Error(e.runtime.lastError.message)) : r.singleCallbackArg || o.length <= 1 && !1 !== r.singleCallbackArg ? t.resolve(o[0]) : t.resolve(o)
                    },
                    n = e => 1 == e ? "argument" : "arguments",
                    i = (e, t) => function(r, ...o) {
                        if (o.length < t.minArgs) throw Error(`Expected at least ${t.minArgs} ${n(t.minArgs)} for ${e}(), got ${o.length}`);
                        if (o.length > t.maxArgs) throw Error(`Expected at most ${t.maxArgs} ${n(t.maxArgs)} for ${e}(), got ${o.length}`);
                        return new Promise((n, i) => {
                            if (t.fallbackToNoCallback) try {
                                r[e](...o, a({
                                    resolve: n,
                                    reject: i
                                }, t))
                            } catch (a) {
                                console.warn(`${e} API method doesn't seem to support the callback parameter, falling back to call it without a callback: `, a), r[e](...o), t.fallbackToNoCallback = !1, t.noCallback = !0, n()
                            } else t.noCallback ? (r[e](...o), n()) : r[e](...o, a({
                                resolve: n,
                                reject: i
                            }, t))
                        })
                    },
                    l = (e, t, r) => new Proxy(t, {
                        apply: (t, o, a) => r.call(o, e, ...a)
                    }),
                    s = Function.call.bind(Object.prototype.hasOwnProperty),
                    c = (e, t = {}, r = {}) => {
                        let o = Object.create(null),
                            a = Object.create(e);
                        return new Proxy(a, {
                            has: (t, r) => r in e || r in o,
                            get(a, n, u) {
                                if (n in o) return o[n];
                                if (!(n in e)) return;
                                let g = e[n];
                                if ("function" == typeof g) {
                                    if ("function" == typeof t[n]) g = l(e, e[n], t[n]);
                                    else if (s(r, n)) {
                                        let t = i(n, r[n]);
                                        g = l(e, e[n], t)
                                    } else g = g.bind(e)
                                } else if ("object" == typeof g && null !== g && (s(t, n) || s(r, n))) g = c(g, t[n], r[n]);
                                else {
                                    if (!s(r, "*")) return Object.defineProperty(o, n, {
                                        configurable: !0,
                                        enumerable: !0,
                                        get: () => e[n],
                                        set(t) {
                                            e[n] = t
                                        }
                                    }), g;
                                    g = c(g, t[n], r["*"])
                                }
                                return o[n] = g, g
                            },
                            set: (t, r, a, n) => (r in o ? o[r] = a : e[r] = a, !0),
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
                    d = new r(e => "function" != typeof e ? e : function(t, r, a) {
                        let n, i, l = !1,
                            s = new Promise(e => {
                                n = function(t) {
                                    l = !0, e(t)
                                }
                            });
                        try {
                            i = e(t, r, n)
                        } catch (e) {
                            i = Promise.reject(e)
                        }
                        let c = !0 !== i && o(i);
                        return (!0 === i || !!c || !!l) && ((e => {
                            e.then(e => {
                                a(e)
                            }, e => {
                                a({
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
                        if (o.length < t.minArgs) throw Error(`Expected at least ${t.minArgs} ${n(t.minArgs)} for ${e}(), got ${o.length}`);
                        if (o.length > t.maxArgs) throw Error(`Expected at most ${t.maxArgs} ${n(t.maxArgs)} for ${e}(), got ${o.length}`);
                        return new Promise((e, t) => {
                            let a = p.bind(null, {
                                resolve: e,
                                reject: t
                            });
                            o.push(a), r.sendMessage(...o)
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
        }, "function" == typeof e && e.amd ? e("webextension-polyfill", ["module"], a) : a(r)
    }, {}],
    kPpVM: [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        o.defineInteropFlag(r), o.export(r, "uploadImagesToFacebook", () => h);
        let a = (e, t) => Math.floor(e + Math.random() * (t - e + 1));

        function n(e) {
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
            let a = await o.blob();
            return a.size > 8388608 ? "" : await new Promise((e, t) => {
                let r = new FileReader;
                r.onloadend = () => e(r.result), r.onerror = t, r.readAsDataURL(a)
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
                await n(300);
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
                await n(250)
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
                a = atob(o),
                n = [];
            for (let e = 0; e < a.length; e += 512) {
                let t = a.slice(e, e + 512),
                    r = new Uint8Array(t.length);
                for (let e = 0; e < t.length; e++) r[e] = t.charCodeAt(e);
                n.push(r.buffer)
            }
            return new File(n, t, {
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
            console.log(`[Marketplace Upload] Starting progressive upload for ${t.length} images`);
            let r = 0;
            for (let e = 0; e < t.length; e++) {
                let o = t[e];
                if (!o || "string" != typeof o) {
                    console.warn(`[Marketplace Upload] Image ${e+1}: skipping invalid URL`);
                    continue
                }
                let i = o.startsWith("data:");
                try {
                    let s;
                    if (i) {
                        console.log(`[Marketplace Upload] Image ${e+1}/${t.length}: data-URL detected, converting locally`);
                        let r = p(o),
                            a = m(r),
                            n = `IMG_${String(e+1).padStart(2,"0")}.${a}`;
                        s = f(o, n)
                    } else {
                        console.log(`[Marketplace Upload] Image ${e+1}/${t.length}: fetching directly...`);
                        let r = await l(o);
                        if (!r) {
                            console.warn(`[Marketplace Upload] Image ${e+1}: fetch returned empty, skipping`);
                            continue
                        }
                        let a = p(r),
                            n = m(a),
                            i = `IMG_${String(e+1).padStart(2,"0")}.${n}`;
                        s = f(r, i)
                    }
                    if (0 === s.size) {
                        console.warn(`[Marketplace Upload] Image ${e+1}: file size is 0, skipping`);
                        continue
                    }
                    if (s.size > 8388608) {
                        console.warn(`[Marketplace Upload] Image ${e+1}: file too large (${(s.size/1024/1024).toFixed(1)}MB), skipping`);
                        continue
                    }
                    let c = u();
                    if (!c && (console.log(`[Marketplace Upload] Image ${e+1}: file input not found, waiting 500ms...`), await n(500), !(c = u()))) {
                        console.warn(`[Marketplace Upload] Image ${e+1}: file input still not found, skipping`);
                        continue
                    }
                    let h = g(),
                        y = new DataTransfer;
                    y.items.add(s), c.value = "", c.files = y.files, c.dispatchEvent(new Event("change", {
                        bubbles: !0
                    })), r++, console.log(`[Marketplace Upload] Image ${e+1}/${t.length}: uploaded (${(s.size/1024).toFixed(0)}KB, ${i?"data-url":"remote"}), waiting for preview...`);
                    let w = await d(h);
                    w || console.warn(`[Marketplace Upload] Image ${e+1}: preview didn't appear within timeout, continuing anyway`), e < t.length - 1 && await n(a(800, 1500))
                } catch (t) {
                    console.error(`[Marketplace Upload] Image ${e+1}: failed:`, t)
                }
            }
            console.log(`[Marketplace Upload] Done \u2014 ${r}/${t.length} images uploaded`)
        }
    }, {
        "@parcel/transformer-js/src/esmodule-helpers.js": "hbR2Q"
    }],
    hbR2Q: [function(e, t, r) {
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
    "2tucF": [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        o.defineInteropFlag(r), o.export(r, "AIDescription", () => l), o.export(r, "generateAIDescription", () => i);
        var a = e("./aiAttributes"),
            n = e("./helping");
        async function i(e) {
            try {
                let t, r;
                let o = await chrome.storage.local.get("description"),
                    a = o?.description || "";
                a = a.replace(/\"/g, "").trim();
                let i = a && a.length > 0;
                t = i ? `You are a vehicle listing writer for Facebook Marketplace.

CRITICAL: Follow the user's instructions EXACTLY. They override everything else.

USER INSTRUCTIONS:
${a}

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
                    r = await (0, n.fetchJson)("https://sag.gemquery.com/api/v1/generate-text", {
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
            let t = await (0, a.extractAttributesFromDescription)(e);
            return t || ""
        }
    }, {
        "./aiAttributes": "7eKeW",
        "./helping": "lPT9I",
        "@parcel/transformer-js/src/esmodule-helpers.js": "hbR2Q"
    }],
    "7eKeW": [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        async function a(e) {
            try {
                let t = await chrome.storage.local.get("password"),
                    r = t.password?.replace(/\"/g, "") || "",
                    o = ["Black", "Blue", "Brown", "Gold", "Green", "Gray", "Pink", "Purple", "Red", "Silver", "White"],
                    a = `
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
                    n = await fetch("https://sag.gemquery.com/api/v1/generate-text", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            api_key: r,
                            system_prompt: a,
                            user_prompt: e,
                            model: "gpt-4o-mini",
                            max_tokens: 200
                        })
                    }).then(e => e.json());
                if (n.success) try {
                    let e = n.text_response.trim();
                    e = e.replace(/(\w+):/g, '"$1":').replace(/:\s*([A-Za-z][A-Za-z\s]*[A-Za-z])\s*([,}])/g, ': "$1"$2').replace(/:\s*([A-Za-z][A-Za-z]*)\s*([,}])/g, ': "$1"$2');
                    let t = JSON.parse(e);
                    return t
                } catch (e) {
                    console.error("[UnifiedAI] JSON parse error:", e, n.text_response), console.error("[UnifiedAI] Attempted to clean response:", n.text_response.trim())
                } else console.error("[UnifiedAI] API error:", n.error)
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
        o.defineInteropFlag(r), o.export(r, "extractAttributesFromDescription", () => a)
    }, {
        "@parcel/transformer-js/src/esmodule-helpers.js": "hbR2Q"
    }],
    lPT9I: [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        o.defineInteropFlag(r), o.export(r, "applyCropToBlob", () => L), o.export(r, "fetchJson", () => U), o.export(r, "cleanSellerDesc", () => R), o.export(r, "cleanTextForGroup", () => M), o.export(r, "parsePrice", () => D), o.export(r, "SaveWebsiteInfoInLocal", () => F), o.export(r, "filterAllowedSites", () => $), o.export(r, "sanitizeVehiclesData", () => S), o.export(r, "listVehicleOnLocalStorage", () => d), o.export(r, "checkVehicles", () => u), o.export(r, "syncClientData", () => c), o.export(r, "csvJSON", () => l), o.export(r, "getPostedVehicles", () => s), o.export(r, "listVehicleOnServer", () => g), o.export(r, "cleanString", () => y), o.export(r, "getPreviousPostedVehiclesFromLocalStorage", () => w), o.export(r, "getWhereToPostData", () => b), o.export(r, "getGroupUrl", () => A), o.export(r, "getAlreadyAddedGroups", () => k), o.export(r, "checkIfAdded", () => x), o.export(r, "SaveFbGroup", () => v), o.export(r, "SaveGroupsData", () => E), o.export(r, "saveFbGroupsOnServer", () => _), o.export(r, "extractGroupTitle", () => C), o.export(r, "validateGroupData", () => T), o.export(r, "enterText", () => f), o.export(r, "findDivWithText", () => m), o.export(r, "uploadImagesFbGroups", () => I), o.export(r, "uploadImagesFbEvent", () => h), o.export(r, "updateVehiclePrice", () => p);
        var a = e("papaparse"),
            n = o.interopDefault(a),
            i = e("~common/browserMethods");

        function l(e) {
            try {
                if (!e || "string" != typeof e) throw Error("Invalid CSV input. Expected a non-empty string.");
                let t = (0, n.default).parse(e, {
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
                    a = e?.some(e => e === r || e === o);
                return {
                    ...t,
                    Button: a ? "Post Again" : "Post"
                }
            }) : []
        }
        async function g(e, t, r) {
            let o = await chrome.storage.local.get("password"),
                a = o?.password?.replace(/\"/g, ""),
                n = await chrome.storage.local.get("salesManName"),
                i = n?.salesManName?.replace(/\"/g, "");
            i || (i = "Unknown");
            let l = {
                api_key: a,
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
            let a = await chrome.storage.local.get("salesManName"),
                n = a?.salesManName?.replace(/\"/g, "");
            n || (n = "Unknown");
            let i = await chrome.storage.local.get("already_posted_vehicles"),
                l = [];
            l = i && i?.already_posted_vehicles ? i?.already_posted_vehicles : [], l?.push({
                vehicle_url: e,
                listed_at: t,
                vin: r,
                stock_number: o,
                salesman_name: n,
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
                salesman_name: n
            } : c.push({
                vehicle_url: e,
                listed_at: t,
                vin: r,
                stock_number: o,
                salesman_name: n,
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
                let a = await chrome.storage.local.get("soldVehicles"),
                    n = a?.soldVehicles || [];
                n = n.map(r => r.vin === e ? {
                    ...r,
                    price: t
                } : r), await chrome.storage.local.set({
                    soldVehicles: n
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
                    let a = await o.blob(),
                        n = new File([a], `${+new Date}.jpg`, {
                            type: "image/webp"
                        });
                    console.log("Image uploaded successfully", n.size), t.items.add(n), await (0, i.asyncSleep)(.1)
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
            let a = {
                facebookGroup: e,
                whereToPost: t
            };
            return a
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
                a = o ? o.href : r?.href?.trim()?.replace('"', "")?.replace('"', "");
            try {
                let e = await k();
                t(e.includes(a))
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
                let a = o?.replace("You", "")?.replace("you", "")?.replace("last", "")?.replace("Last", "")?.replace("visited", "")?.replace("visit", "")?.replace("Visit", "")?.replace("Visited", "")?.replace("have", "")?.replace("had", "")?.replace("weeks", "")?.replace("week", "")?.replace("ago", "")?.replace(/\b[1-9]\b/g, "")?.trim();
                if (!a || a.length < 3) throw Error("Group title too short after cleaning");
                return a
            } catch (e) {
                throw console.error("An error occurred while extracting the title:", e), Error("Unable to extract valid group title")
            }
        }

        function T(e, t) {
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
        async function v(e) {
            await chrome.storage.local.set({
                facebookGroup: e
            })
        }
        async function E(e) {
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
        async function _(e, t) {
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
                let a = await r.json();
                if (console.log(a, "data"), a.error) throw Error(a.error);
                return a
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
                for (let [a, n] of Object.entries(e)) {
                    if (null == n) continue;
                    let e = a.trim().replace(t, ""),
                        i = n;
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
                let a = o.Description || "";
                if (o.OriginalDescription = a, !a || "" === a.toString().trim() || "no description" === a.toString().trim().toLowerCase()) {
                    let e = ["imageurls", "url", "vehicleid", "vin", "latitude", "longitude", "lat", "lon", "mileagevalue", "stock_number", "id", "dealer_id", "dealerid"],
                        t = [],
                        r = o.Title || "",
                        a = o.Price || "";
                    for (let [n, i] of Object.entries(o)) {
                        let o = n.toLowerCase();
                        if (e.includes(o) || "originaldescription" === o || "description" === o || "title" === o || "price" === o || "button" === o || null == i) continue;
                        let l = i.toString().trim();
                        "" !== l && "0" !== l && l !== r && l !== a && t.push(`${n}: ${l}`)
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
                        let [e, t] = o.split(","), r = e.match(/data:(.*?);/), a = r ? r[1] : "image/jpeg", n = atob(t), i = new Uint8Array(n.length);
                        for (let e = 0; e < n.length; e++) i[e] = n.charCodeAt(e);
                        return new Blob([i], {
                            type: a
                        })
                    }
                    return await t(o)
                }, o = async (e, o) => {
                    let a = "string" == typeof e && (e.startsWith("blob:") || e.startsWith("data:"));
                    if (a) return await t(e);
                    try {
                        return console.log(`[UploadFBGroups] Image ${o+1}: trying background-storage fetch`), await r(e)
                    } catch (r) {
                        return console.warn(`[UploadFBGroups] Image ${o+1}: background-storage fetch failed, trying direct fetch:`, r), await t(e)
                    }
                }, a = null, n = new DataTransfer, l = 0;
                for (let t = 0; t < e.length; t++) {
                    let r = e[t];
                    if (!r || "string" != typeof r) {
                        console.warn(`Skipping invalid image URL at index ${t}:`, r);
                        continue
                    }
                    let a = 0,
                        s = !1;
                    for (; a < 2 && !s;) try {
                        let a = await o(r, t);
                        if (!a || 0 === a.size) throw Error("Empty or invalid blob data");
                        if (a.size > 4194304) {
                            console.warn(`Skipping image ${t+1}/${e.length}: Size ${(a.size/1024/1024).toFixed(2)}MB exceeds 4MB limit`), s = !0;
                            continue
                        }
                        let c = Date.now(),
                            u = Math.random().toString(36).substr(2, 9),
                            g = `image_${c}_${u}.jpg`,
                            d = new File([a], g, {
                                type: "image/jpeg",
                                lastModified: c
                            });
                        n.items.add(d), l++, s = !0, console.log(`Successfully processed image ${t+1}/${e.length} (${(a.size/1024).toFixed(2)}KB)`), await (0, i.asyncSleep)(.05)
                    } catch (r) {
                        a++, console.warn(`Attempt ${a}/2 failed for image ${t+1}:`, r.message), a < 2 ? await (0, i.asyncSleep)(.2 * Math.pow(2, a)) : (console.error(`Failed to process image ${t+1}/${e.length} after 2 attempts:`, r), s = !0)
                    }
                }
                if (0 === l) {
                    console.error("[UploadFBGroups] No images were successfully processed \u2014 aborting upload");
                    return
                }
                if (console.log(`[UploadFBGroups] Successfully processed ${l}/${e.length} images, total files in DataTransfer: ${n.files.length}`), !(a = await O())) {
                    console.error("[UploadFBGroups] Could not find any file input element on the page"), console.log("[UploadFBGroups] All inputs on page:", document.querySelectorAll("input").length), console.log("[UploadFBGroups] File inputs on page:", document.querySelectorAll('input[type="file"]').length);
                    return
                }
                console.log(`[UploadFBGroups] File input found. Accept: ${a.accept||"any"}, Multiple: ${a.multiple}`);
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
                                a = o.find(t => {
                                    let r = (t.textContent || "").trim().toLowerCase();
                                    return e.includes(r)
                                });
                            return a || null
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
                        })(t, n.files)), !e) {
                        for (let e of (a.files = n.files, ["change", "input"])) {
                            let t = new Event(e, {
                                bubbles: !0,
                                cancelable: !0
                            });
                            a.dispatchEvent(t), await (0, i.asyncSleep)(.02)
                        }
                        e = !0
                    }
                    console.log(`[UploadFBGroups] Upload triggered successfully with ${n.files.length} files (method: ${t&&e?"drag-drop":"file-input"})`)
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

        function $(e, t) {
            try {
                if (!Array.isArray(e)) throw Error("allowedWebsites must be an array");
                if (!Array.isArray(t)) throw Error("allSitesData must be an array");
                return t.filter(t => e.includes(t?.website_url))
            } catch (e) {
                return console.error("Error in filterAllowedSites:", e), []
            }
        }
        async function F(e, t) {
            try {
                let r = e?.split(",")?.map(e => e?.trim());
                await chrome.storage.local.set({
                    allowedWebsites: r
                });
                let o = await fetch("https://sag.gemquery.com/api/v1/get-website"),
                    a = await o.json(),
                    n = $(r, a.websites);
                "hamzamaqbool@gmail.com" == t ? await chrome.storage.local.set({
                    siteDetails: a.websites
                }) : await chrome.storage.local.set({
                    siteDetails: n
                })
            } catch (e) {
                console.error(e)
            }
        }
        let D = e => {
            if (!e) return 0;
            let t = e.replace(/C\$|CAD\$|\$|\u20ac|\u00a3|\u20b9|\u00a5|\u20a9|\u20b1|\u20bd/g, "").replace(/,/g, "").replace(/\s+/g, "").replace(/[^\d.-]/g, "");
            t.includes("-") && (t = t.split("-")[0]), (t.includes("/mo") || t.includes("/month")) && (t = t.replace(/\/mo.*|\/month.*/, ""));
            let r = parseFloat(t);
            return isNaN(r) ? 0 : r
        };

        function R(e) {
            if (!e) return "";
            let t = e.replace(/\\n/g, "\n"),
                r = t.replace(/\s+/g, " "),
                o = r.replace(/\n+/g, "\n").trim();
            return o
        }
        async function U(e, t) {
            let r = await fetch(e, t);
            if (!r.ok) throw Error(`HTTP error! status: ${r.status}`);
            return await r.json()
        }
        async function L(e, t) {
            try {
                if (!t || 0 === t.top && 0 === t.bottom && 0 === t.left && 0 === t.right) return e;
                let r = new Image,
                    o = URL.createObjectURL(e);
                await new Promise((e, t) => {
                    r.onload = e, r.onerror = t, r.src = o
                });
                let a = document.createElement("canvas"),
                    n = a.getContext("2d");
                if (!n) return console.error("Failed to get canvas context"), e;
                let i = r.height * t.top / 100,
                    l = r.height * t.bottom / 100,
                    s = r.width * t.left / 100,
                    c = r.width * t.right / 100,
                    u = r.width - s - c,
                    g = r.height - i - l;
                return a.width = u, a.height = g, n.drawImage(r, s, i, u, g, 0, 0, u, g), URL.revokeObjectURL(o), new Promise((t, r) => {
                    a.toBlob(o => {
                        o ? (console.log(`Image cropped successfully. Original: ${(e.size/1024).toFixed(2)}KB, Cropped: ${(o.size/1024).toFixed(2)}KB`), t(o)) : r(Error("Failed to create cropped blob"))
                    }, "image/jpeg", .9)
                })
            } catch (t) {
                return console.error("Error applying crop to blob:", t), e
            }
        }
    }, {
        papaparse: "48ohA",
        "~common/browserMethods": "7ZVwc",
        "@parcel/transformer-js/src/esmodule-helpers.js": "hbR2Q"
    }],
    "48ohA": [function(t, r, o) {
        var a;
        a = function e() {
            var t, r = "undefined" != typeof self ? self : "undefined" != typeof window ? window : void 0 !== r ? r : {},
                o = !r.document && !!r.postMessage,
                a = r.IS_PAPA_WORKER || !1,
                n = {},
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
                        t || (n = this._config.quoteChar || '"', t = this._handle.guessLineEndings(e, n)), e = [...e.split(t).slice(o)].join(t)
                    }
                    this.isFirstChunk && k(this._config.beforeFirstChunk) && void 0 !== (n = this._config.beforeFirstChunk(e)) && (e = n), this.isFirstChunk = !1, this._halted = !1;
                    var o = this._partialLine + e,
                        n = (this._partialLine = "", this._handle.parse(o, this._baseIndex, !this._finished));
                    if (!this._handle.paused() && !this._handle.aborted()) {
                        if (e = n.meta.cursor, this._finished || (this._partialLine = o.substring(e - this._baseIndex), this._baseIndex = e), n && n.data && (this._rowCount += n.data.length), o = this._finished || this._config.preview && this._rowCount >= this._config.preview, a) r.postMessage({
                            results: n,
                            workerId: l.WORKER_ID,
                            finished: o
                        });
                        else if (k(this._config.chunk) && !t) {
                            if (this._config.chunk(n, this._handle), this._handle.paused() || this._handle.aborted()) return void(this._halted = !0);
                            this._completeResults = n = void 0
                        }
                        return this._config.step || this._config.chunk || (this._completeResults.data = this._completeResults.data.concat(n.data), this._completeResults.errors = this._completeResults.errors.concat(n.errors), this._completeResults.meta = n.meta), this._completed || !o || !k(this._config.complete) || n && n.meta.aborted || (this._config.complete(this._completeResults, this._input), this._completed = !0), o || n && n.meta.paused || this._nextChunk(), n
                    }
                    this._halted = !0
                }, this._sendError = function(e) {
                    k(this._config.error) ? this._config.error(e) : a && this._config.error && r.postMessage({
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
                            var e, r, a = this._config.downloadRequestHeaders;
                            for (r in a) t.setRequestHeader(r, a[r])
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
                        a = (this._config.chunkSize && (a = Math.min(this._start + this._config.chunkSize, this._input.size), e = r.call(e, this._start, a)), t.readAsText(e, this._config.encoding));
                    o || this._chunkLoaded({
                        target: {
                            result: a
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
                var t, r, o, a, n = /^\s*-?(\d+\.?|\.\d+|\d+\.\d+)([eE][-+]?\d+)?\s*$/,
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
                                for (var t, r = 0; A() && r < h.data.length; r++) h.data[r].forEach(a);
                                h.data.splice(0, 1)
                            } else h.data.forEach(a)
                        }

                        function a(t, r) {
                            k(e.transformHeader) && (t = e.transformHeader(t, r)), p.push(t)
                        }
                    }

                    function s(t, r) {
                        for (var o = e.header ? {} : [], a = 0; a < t.length; a++) {
                            var l, s, c = a,
                                g = t[a],
                                g = (l = c = e.header ? a >= p.length ? "__parsed_extra" : p[a] : c, s = g = e.transform ? e.transform(g, c) : g, (e.dynamicTypingFunction && void 0 === e.dynamicTyping[l] && (e.dynamicTyping[l] = e.dynamicTypingFunction(l)), !0 === (e.dynamicTyping[l] || e.dynamicTyping)) ? "true" === s || "TRUE" === s || "false" !== s && "FALSE" !== s && ((e => {
                                    if (n.test(e) && -9007199254740992 < (e = parseFloat(e)) && e < 9007199254740992) return 1
                                })(s) ? parseFloat(s) : i.test(s) ? new Date(s) : "" === s ? null : s) : s);
                            "__parsed_extra" === c ? (o[c] = o[c] || [], o[c].push(g)) : o[c] = g
                        }
                        return e.header && (a > p.length ? x("FieldMismatch", "TooManyFields", "Too many fields: expected " + p.length + " fields but parsed " + a, u + r) : a < p.length && x("FieldMismatch", "TooFewFields", "Too few fields: expected " + p.length + " fields but parsed " + a, u + r)), o
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
                k(e.step) && (a = e.step, e.step = function(t) {
                    h = t, A() ? w() : (w(), 0 !== h.data.length && (c += t.data.length, e.preview && c > e.preview ? r.abort() : (h.data = h.data[0], a(h, s))))
                }), this.parse = function(a, n, i) {
                    var s = e.quoteChar || '"',
                        s = (e.newline || (e.newline = this.guessLineEndings(a, s)), o = !1, e.delimiter ? k(e.delimiter) && (e.delimiter = e.delimiter(a), h.meta.delimiter = e.delimiter) : ((s = ((t, r, o, a, n) => {
                            var i, s, c, u;
                            n = n || [",", "	", "|", ";", l.RECORD_SEP, l.UNIT_SEP];
                            for (var g = 0; g < n.length; g++) {
                                for (var d, p = n[g], m = 0, h = 0, w = 0, b = (c = void 0, new f({
                                        comments: a,
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
                        })(a, e.newline, e.skipEmptyLines, e.comments, e.delimitersToGuess)).successful ? e.delimiter = s.bestDelimiter : (o = !0, e.delimiter = l.DefaultDelimiter), h.meta.delimiter = e.delimiter), b(e));
                    return e.preview && e.header && s.preview++, t = a, h = (r = new f(s)).parse(t, n, i), w(), g ? {
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
                    for (var o = 0, a = 0; a < r.length; a++) "\n" === r[a][0] && o++;
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
                    a = e.step,
                    n = e.preview,
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
                        x = k(a),
                        C = [],
                        T = [],
                        v = [],
                        E = d = 0;
                    if (!l) return P();
                    if (i || !1 !== i && -1 === l.indexOf(u)) {
                        for (var _ = l.split(r), S = 0; S < _.length; S++) {
                            if (v = _[S], d += v.length, S !== _.length - 1) d += r.length;
                            else if (h) break;
                            if (!o || v.substring(0, A) !== o) {
                                if (x) {
                                    if (C = [], D(v.split(t)), N(), p) return P()
                                } else D(v.split(t));
                                if (n && n <= S) return C = C.slice(0, n), P(!0)
                            }
                        }
                        return P()
                    }
                    for (var M = l.indexOf(t, d), I = l.indexOf(r, d), O = RegExp(m(g) + m(u), "g"), $ = l.indexOf(u, d);;)
                        if (l[d] === u)
                            for ($ = d, d++;;) {
                                if (-1 === ($ = l.indexOf(u, $ + 1))) return h || T.push({
                                    type: "Quotes",
                                    code: "MissingQuotes",
                                    message: "Quoted field unterminated",
                                    row: C.length,
                                    index: d
                                }), U();
                                if ($ === y - 1) return U(l.substring(d, $).replace(O, u));
                                if (u === g && l[$ + 1] === g) $++;
                                else if (u === g || 0 === $ || l[$ - 1] !== g) {
                                    -1 !== M && M < $ + 1 && (M = l.indexOf(t, $ + 1));
                                    var F = R(-1 === (I = -1 !== I && I < $ + 1 ? l.indexOf(r, $ + 1) : I) ? M : Math.min(M, I));
                                    if (l.substr($ + 1 + F, w) === t) {
                                        v.push(l.substring(d, $).replace(O, u)), l[d = $ + 1 + F + w] !== u && ($ = l.indexOf(u, d)), M = l.indexOf(t, d), I = l.indexOf(r, d);
                                        break
                                    }
                                    if (F = R(I), l.substring($ + 1 + F, $ + 1 + F + b) === r) {
                                        if (v.push(l.substring(d, $).replace(O, u)), L($ + 1 + F + b), M = l.indexOf(t, d), $ = l.indexOf(u, d), x && (N(), p)) return P();
                                        if (n && C.length >= n) return P(!0);
                                        break
                                    }
                                    T.push({
                                        type: "Quotes",
                                        code: "InvalidQuotes",
                                        message: "Trailing quote on quoted field is malformed",
                                        row: C.length,
                                        index: d
                                    }), $++
                                }
                            } else if (o && 0 === v.length && l.substring(d, d + A) === o) {
                                if (-1 === I) return P();
                                d = I + b, I = l.indexOf(r, d), M = l.indexOf(t, d)
                            } else if (-1 !== M && (M < I || -1 === I)) v.push(l.substring(d, M)), d = M + w, M = l.indexOf(t, d);
                    else {
                        if (-1 === I) break;
                        if (v.push(l.substring(d, I)), L(I + b), x && (N(), p)) return P();
                        if (n && C.length >= n) return P(!0)
                    }
                    return U();

                    function D(e) {
                        C.push(e), E = d
                    }

                    function R(e) {
                        return -1 !== e && (e = l.substring($ + 1, e)) && "" === e.trim() ? e.length : 0
                    }

                    function U(e) {
                        return h || (void 0 === e && (e = l.substring(d)), v.push(e), d = y, D(v), x && N()), P()
                    }

                    function L(e) {
                        d = e, D(v), v = [], I = l.indexOf(r, d)
                    }

                    function P(o) {
                        if (e.header && !f && C.length && !c) {
                            var a = C[0],
                                n = Object.create(null),
                                i = new Set(a);
                            let t = !1;
                            for (let r = 0; r < a.length; r++) {
                                let o = a[r];
                                if (n[o = k(e.transformHeader) ? e.transformHeader(o, r) : o]) {
                                    let e, l = n[o];
                                    for (; e = o + "_" + l, l++, i.has(e););
                                    i.add(e), a[r] = e, n[o]++, t = !0, (s = null === s ? {} : s)[e] = o
                                } else n[o] = 1, a[r] = o;
                                i.add(o)
                            }
                            t && console.warn("Duplicate headers found and renamed."), c = !0
                        }
                        return {
                            data: C,
                            errors: T,
                            meta: {
                                delimiter: t,
                                linebreak: r,
                                aborted: p,
                                truncated: !!o,
                                cursor: E + (f || 0),
                                renamedHeaders: s
                            }
                        }
                    }

                    function N() {
                        a(P()), C = [], T = []
                    }
                }, this.abort = function() {
                    p = !0
                }, this.getCharIndex = function() {
                    return d
                }
            }

            function h(e) {
                var t = e.data,
                    r = n[t.workerId],
                    o = !1;
                if (t.error) r.userError(t.error, t.file);
                else if (t.results && t.results.data) {
                    var a = {
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
                            }, a), !o); i++);
                        delete t.results
                    } else k(r.userChunk) && (r.userChunk(t.results, a, t.file), delete t.results)
                }
                t.finished && !o && y(t.workerId, t.results)
            }

            function y(e, t) {
                var r = n[e];
                k(r.userComplete) && r.userComplete(t), r.terminate(), delete n[e]
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
                var a, s, p, m, f = (o = o || {}).dynamicTyping || !1;
                if (k(f) && (o.dynamicTypingFunction = f, f = {}), o.dynamicTyping = f, o.transform = !!k(o.transform) && o.transform, !o.worker || !l.WORKERS_SUPPORTED) return f = null, l.NODE_STREAM_INPUT, "string" == typeof t ? (t = 65279 !== (a = t).charCodeAt(0) ? a : a.slice(1), f = new(o.download ? c : g)(o)) : !0 === t.readable && k(t.read) && k(t.on) ? f = new d(o) : (r.File && t instanceof File || t instanceof Object) && (f = new u(o)), f.stream(t);
                (f = !!l.WORKERS_SUPPORTED && (p = r.URL || r.webkitURL || null, m = e.toString(), s = l.BLOB_URL || (l.BLOB_URL = p.createObjectURL(new Blob(["var global = (function() { if (typeof self !== 'undefined') { return self; } if (typeof window !== 'undefined') { return window; } if (typeof global !== 'undefined') { return global; } return {}; })(); global.IS_PAPA_WORKER=true; ", "(", m, ")();"], {
                    type: "text/javascript"
                }))), (s = new r.Worker(s)).onmessage = h, s.id = i++, n[s.id] = s)).userStep = o.step, f.userChunk = o.chunk, f.userComplete = o.complete, f.userError = o.error, o.step = k(o.step), o.chunk = k(o.chunk), o.complete = k(o.complete), o.error = k(o.error), delete o.worker, f.postMessage({
                    input: t,
                    config: o,
                    workerId: f.id
                })
            }, l.unparse = function(e, t) {
                var r = !1,
                    o = !0,
                    a = ",",
                    n = "\r\n",
                    i = '"',
                    s = i + i,
                    c = !1,
                    u = null,
                    g = !1,
                    d = ((() => {
                        if ("object" == typeof t) {
                            if ("string" != typeof t.delimiter || l.BAD_DELIMITERS.filter(function(e) {
                                    return -1 !== t.delimiter.indexOf(e)
                                }).length || (a = t.delimiter), ("boolean" == typeof t.quotes || "function" == typeof t.quotes || Array.isArray(t.quotes)) && (r = t.quotes), "boolean" != typeof t.skipEmptyLines && "string" != typeof t.skipEmptyLines || (c = t.skipEmptyLines), "string" == typeof t.newline && (n = t.newline), "string" == typeof t.quoteChar && (i = t.quoteChar), "boolean" == typeof t.header && (o = t.header), Array.isArray(t.columns)) {
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
                        for (var c = 0; c < e.length; c++) 0 < c && (i += a), i += f(e[c], c);
                        0 < t.length && (i += n)
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
                                0 < w && !p && (i += a);
                                var b = l && s ? e[w] : w;
                                i += f(t[u][b], w)
                            }
                            u < t.length - 1 && (!r || 0 < g && !p) && (i += n)
                        }
                    }
                    return i
                }

                function f(e, t) {
                    var o, n;
                    return null == e ? "" : e.constructor === Date ? JSON.stringify(e).slice(1, 25) : (n = !1, g && "string" == typeof e && g.test(e) && (e = "'" + e, n = !0), o = e.toString().replace(d, s), (n = n || !0 === r || "function" == typeof r && r(e, t) || Array.isArray(r) && r[t] || ((e, t) => {
                        for (var r = 0; r < t.length; r++)
                            if (-1 < e.indexOf(t[r])) return !0;
                        return !1
                    })(o, l.BAD_DELIMITERS) || -1 < o.indexOf(a) || " " === o.charAt(0) || " " === o.charAt(o.length - 1)) ? i + o + i : o)
                }
            }, l.RECORD_SEP = "\x1e", l.UNIT_SEP = "\x1f", l.BYTE_ORDER_MARK = "\uFEFF", l.BAD_DELIMITERS = ["\r", "\n", '"', l.BYTE_ORDER_MARK], l.WORKERS_SUPPORTED = !o && !!r.Worker, l.NODE_STREAM_INPUT = 1, l.LocalChunkSize = 10485760, l.RemoteChunkSize = 5242880, l.DefaultDelimiter = ",", l.Parser = f, l.ParserHandle = p, l.NetworkStreamer = c, l.FileStreamer = u, l.StringStreamer = g, l.ReadableStreamStreamer = d, r.jQuery && ((t = r.jQuery).fn.parse = function(e) {
                var o = e.config || {},
                    a = [];
                return this.each(function(e) {
                    if (!("INPUT" === t(this).prop("tagName").toUpperCase() && "file" === t(this).attr("type").toLowerCase() && r.FileReader) || !this.files || 0 === this.files.length) return !0;
                    for (var n = 0; n < this.files.length; n++) a.push({
                        file: this.files[n],
                        inputElem: this,
                        instanceConfig: t.extend({}, o)
                    })
                }), n(), this;

                function n() {
                    if (0 === a.length) k(e.complete) && e.complete();
                    else {
                        var r, o, n, s = a[0];
                        if (k(e.before)) {
                            var c = e.before(s.file, s.inputElem);
                            if ("object" == typeof c) {
                                if ("abort" === c.action) return r = s.file, o = s.inputElem, n = c.reason, void(k(e.error) && e.error({
                                    name: "AbortError"
                                }, r, o, n));
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
                    a.splice(0, 1), n()
                }
            }), a && (r.onmessage = function(e) {
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
        }, "function" == typeof e && e.amd ? e([], a) : r.exports = a()
    }, {}],
    gF6Nj: [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        o.defineInteropFlag(r), o.export(r, "waitUserDelay", () => l), o.export(r, "humanDelay", () => s), o.export(r, "occasionalLongPause", () => c), o.export(r, "performHumanNoise", () => u), o.export(r, "humanClick", () => d), o.export(r, "humanTypeText", () => x), o.export(r, "findGroupComposerField", () => _), o.export(r, "legacyTypeDescription", () => M);
        let a = (e, t) => Math.floor(e + Math.random() * (t - e + 1)),
            n = e => new Promise(t => setTimeout(t, e)),
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
                e > 0 && await n(e)
            }, s = async (e = 150, t = 600) => {
                await n(a(e, t))
            }, c = async (e = .18) => {
                Math.random() < e && await n(a(1e3, 2e3))
            }, u = async e => {
                try {
                    let t = a(-5, 5),
                        r = a(-30, 30);
                    window.scrollBy({
                        left: t,
                        top: r,
                        behavior: "auto"
                    });
                    let o = Math.max(0, Math.min(window.innerWidth, Math.floor(window.innerWidth / 2 + a(-120, 120)))),
                        i = Math.max(0, Math.min(window.innerHeight, Math.floor(window.innerHeight / 2 + a(-120, 120)))),
                        l = a(1, 3);
                    for (let t = 0; t < l; t++) {
                        let t = new MouseEvent("mousemove", {
                            bubbles: !0,
                            clientX: o + a(-8, 8),
                            clientY: i + a(-8, 8)
                        });
                        (e || document.body)?.dispatchEvent(t), await n(a(20, 60))
                    }
                } catch {}
            }, g = async e => {
                try {
                    e.scrollIntoView({
                        block: "center",
                        inline: "center"
                    }), await s(120, 280)
                } catch {}
            }, d = async e => {
                if (!e) return;
                await u(e), await g(e);
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
                i("pointerover"), await n(a(10, 40)), i("mouseover"), await n(a(10, 40)), i("pointerdown"), i("mousedown"), await n(a(40, 120)), e.focus?.(), await n(a(30, 90)), i("pointerup"), i("mouseup"), await n(a(20, 80)), i("click"), await s(), await c(.08)
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
                        A(i, t), await n(a(u, g)), e > 0 && e % a(7, 14) == 0 && await c(d)
                    }
                    await l()
                } catch {}
            }, C = '[role="dialog"] [role="textbox"][contenteditable="true"]', T = [C, '[contenteditable="true"][aria-label="Create a public post\u2026"]', '[contenteditable="true"][aria-label="Create a public post..."]', '[contenteditable="true"][aria-label="Create a public post"]', '[contenteditable="true"][aria-label="Create post\u2026"]', '[contenteditable="true"][aria-label="Create post..."]', '[contenteditable="true"][aria-label="Create post"]', '[contenteditable="true"][aria-label="Create a post"]', '[contenteditable="true"][aria-label*="What\'s on your mind" i]', '[contenteditable="true"][role="textbox"]', '[role="textbox"][contenteditable="true"]', '[contenteditable="true"][aria-multiline="true"]', '[contenteditable="true"][data-lexical-editor]', '[contenteditable="true"][data-contents="true"]'], v = ['[aria-label="Create a public post"]', '[aria-label="Create a public post\u2026"]', '[aria-label="Create a public post..."]', '[aria-label="Create post"]', '[aria-label="Create post\u2026"]', '[aria-label="Create post..."]', '[aria-label="Create a post"]', '[aria-label*="Create post" i]', '[aria-label*="Create a post" i]'], E = e => {
                if (!e) return !1;
                let t = e.getClientRects();
                return t.length > 0 && t[0].width > 0 && t[0].height > 0
            }, _ = () => {
                let e = document.querySelector(C);
                if (e && E(e)) return e;
                for (let e of T) {
                    let t = Array.from(document.querySelectorAll(e)),
                        r = t.find(e => e && E(e) && e.isContentEditable);
                    if (r) return r
                }
                for (let e of v) {
                    let t = document.querySelector(e);
                    if (t && E(t)) {
                        let e = Array.from(t.querySelectorAll('[contenteditable="true"]')).find(e => E(e));
                        if (e) return e
                    }
                }
                let t = Array.from(document.querySelectorAll('[contenteditable="true"]')),
                    r = t.find(e => e && E(e) && e.isContentEditable);
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
                    let a = document.execCommand("insertText", !1, t);
                    return a || (o.deleteContents(), o.insertNode(document.createTextNode(t)), r?.removeAllRanges()), e.dispatchEvent(new Event("input", {
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
        "@parcel/transformer-js/src/esmodule-helpers.js": "hbR2Q"
    }],
    gdHq6: [function(e, t, r) {
        var o = e("@parcel/transformer-js/src/esmodule-helpers.js");
        o.defineInteropFlag(r), o.export(r, "editImage", () => l);
        let a = "";
        async function n(e) {
            let t = await fetch(e);
            if (!t.ok) throw Error(`Failed to download image: ${t.status}`);
            return t.blob()
        }
        async function i(e) {
            let t = await e.arrayBuffer(),
                r = new Uint8Array(t),
                o = [];
            for (let e = 0; e < r.length; e += 8192) o.push(String.fromCharCode(...r.subarray(e, Math.min(e + 8192, r.length))));
            let a = btoa(o.join("")),
                n = e.type || "image/png";
            return `data:${n};base64,${a}`
        }
        async function l(e, t, r, o) {
            let l;
            {
                // XENOKING: image background-removal upload REMOVED. The tool
                // never transmits images to any external server. Return the
                // original image unchanged.
                let xu = await n(e);
                return i(xu)
            }
            console.log("editImage -> downloading", e);
            let c = "string" == typeof t && t.trim().length > 0 ? t : await s(),
                u = await n(e);
            if (["image/avif", "image/webp", ""].includes(u.type)) try {
                console.log("editImage -> converting", u.type || "unknown", "to JPEG");
                let e = await createImageBitmap(u),
                    t = new OffscreenCanvas(e.width, e.height),
                    r = t.getContext("2d");
                r.drawImage(e, 0, 0), u = await t.convertToBlob({
                    type: "image/jpeg",
                    quality: .92
                }), e.close()
            } catch (e) {
                console.warn("editImage -> format conversion failed, sending original:", e)
            }
            let g = u.type || "image/jpeg",
                d = g.includes("png") ? "png" : g.includes("webp") ? "webp" : "jpg",
                p = `image.${d}`,
                m = c.replace(/[\r\n]+/g, " ").trim();
            console.log("editImage -> uploading to /edit, blob size:", u.size, "type:", u.type);
            let f = () => {
                    let e = new FormData;
                    return e.append("prompt", m), r && e.append("height", String(r)), o && e.append("width", String(o)), e.append("file", new File([u], p, {
                        type: g
                    })), e
                },
                h = async () => {
                    console.log("editImage -> falling back to manual multipart body");
                    let e = "----WebKitFormBoundary" + Math.random().toString(36).substring(2),
                        t = (t, r) => `--${e}\r
Content-Disposition: form-data; name="${t}"\r
\r
${r}\r
`,
                        a = t("prompt", m);
                    r && (a += t("height", String(r))), o && (a += t("width", String(o))), a += `--${e}\r
Content-Disposition: form-data; name="file"; filename="${p}"\r
Content-Type: ${g}\r
\r
`;
                    let n = new TextEncoder().encode(a),
                        i = new TextEncoder().encode(`\r
--${e}--\r
`),
                        l = await u.arrayBuffer();
                    return new Blob([n, l, i], {
                        type: `multipart/form-data; boundary=${e}`
                    })
                };
            for (let e = 0; e <= 2; e++) {
                try {
                    if (e < 2) l = await fetch(`${a}/edit`, {
                        method: "POST",
                        body: f()
                    });
                    else {
                        let e = await h();
                        l = await fetch(`${a}/edit`, {
                            method: "POST",
                            body: e
                        })
                    }
                } catch (t) {
                    if (e < 2) {
                        await new Promise(t => setTimeout(t, 1500 * (e + 1)));
                        continue
                    }
                    throw console.error("editImage -> fetch failed (is API running at " + a + "?)", t), Error(`Cannot reach API at ${a}/edit \u2014 is the server running?`)
                }
                if (l && l.ok) break;
                if (l && 400 === l.status && e < 2) {
                    let t = await l.text().catch(() => "");
                    console.warn(`editImage -> 400 on attempt ${e+1}:`, t), await new Promise(t => setTimeout(t, 1500 * (e + 1)));
                    continue
                }
                if (l && !l.ok) {
                    let t = await l.text().catch(() => "");
                    if (e < 2) {
                        await new Promise(t => setTimeout(t, 1500 * (e + 1)));
                        continue
                    }
                    throw console.error("editImage failed", l.status, t), Error(`API error ${l.status}: ${t||"edit failed"}`)
                }
            }
            if (!l || !l.ok) throw Error("edit failed after retries");
            let y = await l.blob();
            return console.log("editImage -> received", y.type, y.size, "bytes"), i(y)
        }
        async function s() {
            let e = `Preserve Original Vehicle at any cost.
Remove only the background and replace it with a clean empty dealership lot. Do not alter or recreate any part of the vehicle. Preserve all original pixels exactly, including logos, emblems, text, reflections, and details, even if blurry. Do not add or change anything on the vehicle. Only replace the background.`,
                t = "";
            try {
                let e = await chrome.storage.local.get("AiImagesInstructions");
                t = "string" == typeof e.AiImagesInstructions ? e.AiImagesInstructions.trim().replace(/\"/g, "") : ""
            } catch (e) {
                t = ""
            }
            return [e, t].filter(Boolean).join(" ")
        }
    }, {
        "@parcel/transformer-js/src/esmodule-helpers.js": "hbR2Q"
    }]
}, ["kgW6q"], "kgW6q", "parcelRequire4d24"), globalThis.define = t;