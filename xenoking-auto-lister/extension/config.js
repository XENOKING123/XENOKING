// ---- XENOKING extension config ----
// BACKEND_URL points at your deployed XENOKING backend. It is baked in below,
// so users only ever see Email + Password (no server field). If you ever move
// the server, change this one line.
//
// TOOL_BUNDLE is the tool's compiled script; the gate injects it only AFTER a
// user is approved, so unapproved users never run the tool code.
window.XENOKING_CONFIG = {
  BACKEND_URL: "https://xenoking-backend.onrender.com",
  TOOL_BUNDLE: "/sidepanel.b7741352.js"
};
