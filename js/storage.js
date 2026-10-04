// storage.js — v1 keeps data in this browser (localStorage).
// Shape mirrors Command Center's global DATA pattern so a Supabase sync
// (same project, new row/table) can be added later without changing app.js.
(function () {
  const KEY = 'homefix-v1';
  const DEFAULT = { fixes: [] };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULT);
      const parsed = JSON.parse(raw);
      return { ...structuredClone(DEFAULT), ...parsed };
    } catch {
      return structuredClone(DEFAULT);
    }
  }

  async function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (err) {
      console.warn('[HomeFix] save failed', err);
      return false;
    }
  }

  window.HomeFixStore = { load, save, KEY };
})();
