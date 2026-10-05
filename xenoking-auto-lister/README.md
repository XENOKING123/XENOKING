# XENOKING Auto Lister

Chrome (MV3) extension that loads a dealership's vehicle inventory and auto-fills
Facebook Marketplace vehicle listings.

- `extension/` — the extension itself. The bundles (`sidepanel.b7741352.js`,
  `facebook.40dee27c.js`, `xkscrape.js`, `static/background/index.js`) are the
  source; there is no separate build step. Zip the contents of `extension/`
  (manifest at the zip root) to ship it.
- Backend: https://xenoking-backend.onrender.com (accounts, owner approval,
  inventory feed for the CDJR build).

## Two builds from one codebase

`./build-zips.sh [out-dir]` produces both zips. They differ only in
`extension/config.js` → `INVENTORY_SOURCE`:

| Build | `INVENTORY_SOURCE` | "Load Vehicles" pulls from |
|---|---|---|
| **CDJR** (`xenoking-extension-cdjr-*.zip`) | `"backend"` | Corwin dealership feed via the XENOKING backend |
| **Public Wholesale** (`xenoking-extension-wholesale-*.zip`) | `"vauto"` | the logged-in vAuto Provision inventory grid (`/Va/Inventory/InventoryData.ashx`) |

The wholesale build shows a single fixed dealership and asks the content script
inside your logged-in vAuto tab for the grid data, so cookies and Referer are
right automatically. Log into vAuto Provision in a tab first, then tap
**Load Vehicles**. The first raw row is logged to the vAuto tab's console as
`[XK vAuto] first raw row` so the field mapping can be tuned from a real
response.
