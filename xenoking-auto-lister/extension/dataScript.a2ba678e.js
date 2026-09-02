var e, a;
"function" == typeof(e = globalThis.define) && (a = e, e = null),
function(a, t, o, i, p) {
    var h = "undefined" != typeof globalThis ? globalThis : "undefined" != typeof self ? self : "undefined" != typeof window ? window : "undefined" != typeof global ? global : {},
        c = "function" == typeof h[i] && h[i],
        l = c.cache || {},
        u = "undefined" != typeof module && "function" == typeof module.require && module.require.bind(module);

    function d(e, t) {
        if (!l[e]) {
            if (!a[e]) {
                var o = "function" == typeof h[i] && h[i];
                if (!t && o) return o(e, !0);
                if (c) return c(e, !0);
                if (u && "string" == typeof e) return u(e);
                var p = Error("Cannot find module '" + e + "'");
                throw p.code = "MODULE_NOT_FOUND", p
            }
            m.resolve = function(t) {
                var o = a[e][1][t];
                return null != o ? o : t
            }, m.cache = {};
            var s = l[e] = new d.Module(e);
            a[e][0].call(s.exports, m, s, s.exports, this)
        }
        return l[e].exports;

        function m(e) {
            var a = m.resolve(e);
            return !1 === a ? {} : d(a)
        }
    }
    d.isParcelRequire = !0, d.Module = function(e) {
        this.id = e, this.bundle = d, this.exports = {}
    }, d.modules = a, d.cache = l, d.parent = c, d.register = function(e, t) {
        a[e] = [function(e, a) {
            a.exports = t
        }, {}]
    }, Object.defineProperty(d, "root", {
        get: function() {
            return h[i]
        }
    }), h[i] = d;
    for (var s = 0; s < t.length; s++) d(t[s]);
    if (o) {
        var m = d(o);
        "object" == typeof exports && "undefined" != typeof module ? module.exports = m : "function" == typeof e && e.amd ? e(function() {
            return m
        }) : p && (this[p] = m)
    }
}({
    VvubE: [function(e, a, t) {
        async function o(e) {
            chrome.runtime.sendMessage({
                message: "postToFacebook",
                vehicleDetails: {
                    '"Body Style"': "",
                    '"Exterior Color"': "Billet Silver Metallic Clearcoat",
                    '"Final Url"': "",
                    '"Image Urls"': "https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-1.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-2.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-3.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-4.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-5.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-6.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-7.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-8.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-9.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-10.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-11.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-12.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-13.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-14.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-15.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-16.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-17.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-18.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-19.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-20.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-21.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-22.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-23.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-24.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-25.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-26.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-27.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-28.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-29.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-30.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-31.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-32.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-33.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-34.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-35.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-36.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-37.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-38.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-39.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-40.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-41.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-42.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-43.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-44.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-45.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-46.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-47.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-48.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-49.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-50.jpg;https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-51.jpg",
                    '"Interior Color"': "Black",
                    '"Mileage Unit"': "MI",
                    '"Mileage Value"': "12",
                    '"State of Vehicle"': "NEW",
                    '"Target Ad Group"': "",
                    '"Target Campaign"': "",
                    '"Vehicle Id"': "91153601",
                    Address: "",
                    Availability: "",
                    Description: "",
                    Drivetrain: "4WD",
                    Latitude: "",
                    Longitude: "",
                    Make: "Ram",
                    Model: "3500",
                    Price: "74465 USD",
                    Title: "2024 Ram 3500",
                    Transmission: "6-Speed Automatic",
                    Trim: "",
                    VIN: "3C63RRJL6RG256269",
                    Year: "2024",
                    date_first_on_lot: "",
                    dealer_id: "",
                    dealer_name: "",
                    dealer_phone: "",
                    "engine\r": '"Cummins 6.7L I6 Turbodiesel"\r',
                    fuel_type: "",
                    stock_number: "G256269",
                    vehicle_type: "",
                    Button: "Post Again",
                    firstImage: "https://vehicle-photos-published.vauto.com/57/17/06/19-802e-45a8-aa55-1159a08cd008/image-1.jpg"
                }
            })
        }
        chrome.runtime.onMessage.addListener((e, a, t) => (e?.message === "runDataScript" && (console.log("running data script", e), o(e?.vehicleDetails)), !0))
    }, {}]
}, ["VvubE"], "VvubE", "parcelRequire4d24"), globalThis.define = a;