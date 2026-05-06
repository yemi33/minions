// features-client.js — Client-side feature flag accessor.
// Reads `window.MINIONS_FEATURES` (data injected at HTML build time:
// { flags: {id: bool}, defaults: {id: bool} }) and exposes synchronous
// `MinionsFeatures.isOn(id)` so gated render code can branch without async.

window.MinionsFeatures = {
  isOn: function(id) {
    var f = window.MINIONS_FEATURES || { flags: {}, defaults: {} };
    if (Object.prototype.hasOwnProperty.call(f.flags, id)) return f.flags[id] === true;
    return f.defaults && f.defaults[id] === true;
  },
  _setLocal: function(id, enabled) {
    if (!window.MINIONS_FEATURES) window.MINIONS_FEATURES = { flags: {}, defaults: {} };
    window.MINIONS_FEATURES.flags[id] = enabled === true;
  },
};
