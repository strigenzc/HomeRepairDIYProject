// app.js — Home Fix v1: photo -> diagnosis -> saved fix with step checklist.
(function () {
  const $ = (sel) => document.querySelector(sel);
  const DATA = window.HomeFixStore.load();
  let photo = null;          // { base64, mimeType, thumb }
  let current = null;        // latest diagnosis shown in the Diagnose tab

  // ---------- helpers ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => 'fx_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const money = (n) => (typeof n === 'number' && isFinite(n) ? '$' + Math.round(n).toLocaleString() : '?');
  const list = (arr) => (Array.isArray(arr) && arr.length ? '<ul>' + arr.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>' : '<p class="muted">None listed.</p>');
  const persist = () => window.HomeFixStore.save(DATA);

  function setStatus(msg, isError) {
    const el = $('#diag-status');
    el.innerHTML = msg;
    el.classList.toggle('error', !!isError);
  }

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });
    $('#panel-diagnose').hidden = name !== 'diagnose';
    $('#panel-fixes').hidden = name !== 'fixes';
    if (name === 'fixes') renderFixes();
  }

  // ---------- photo handling ----------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }
  function resize(img, max, quality) {
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }
  async function takeFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setStatus('That file isn’t an image.', true); return; }
    try {
      const img = await loadImage(file);
      const full = resize(img, 1280, 0.82);
      photo = { base64: full.split(',')[1], mimeType: 'image/jpeg', thumb: resize(img, 240, 0.7) };
      $('#photo-preview').src = full;
      $('#photo-preview').hidden = false;
      $('#drop-hint').hidden = true;
      $('#photo-clear').hidden = false;
      setStatus('');
    } catch {
      setStatus('Couldn’t read that photo. HEIC files from a computer may not open here, so try a JPEG or a screenshot.', true);
    }
  }
  function clearPhoto() {
    photo = null;
    $('#photo').value = '';
    $('#photo-preview').hidden = true;
    $('#photo-preview').removeAttribute('src');
    $('#drop-hint').hidden = false;
    $('#photo-clear').hidden = true;
  }
  $('#photo').addEventListener('change', (e) => takeFile(e.target.files[0]));
  $('#photo-clear').addEventListener('click', clearPhoto);
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => takeFile(e.dataTransfer.files[0]));

  // ---------- diagnose ----------
  $('#diag-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const description = $('#desc').value.trim();
    if (!photo && !description) { setStatus('Add a photo, a description, or both.', true); return; }

    const btn = $('#diag-btn');
    btn.disabled = true;
    setStatus('<span class="spinner"></span>Looking at it… this can take up to a minute.');
    $('#result').innerHTML = '';

    try {
      const res = await fetch('/.netlify/functions/diagnose-repair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          room: $('#room').value,
          homeAge: $('#home-age').value.trim(),
          imageBase64: photo ? photo.base64 : '',
          mimeType: photo ? photo.mimeType : '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
      current = {
        diagnosis: data.diagnosis,
        description,
        room: $('#room').value,
        homeAge: $('#home-age').value.trim(),
        thumb: photo ? photo.thumb : '',
      };
      setStatus('');
      renderResult();
    } catch (err) {
      setStatus(esc(err.message || 'Something went wrong. Try again.'), true);
    } finally {
      btn.disabled = false;
    }
  });

  function diagnosisHTML(d, opts) {
    const { fix } = opts || {};
    const s = d.safety || {};
    const done = fix ? fix.stepsDone || [] : [];
    const parts = [];

    if (d.isHomeRepairPhoto === false) {
      parts.push('<div class="lowconf">This doesn’t look like a home-repair photo. Try a closer shot of the problem area, or describe it in words.</div>');
    }
    if (s.callPro) {
      parts.push(`<div class="pro-banner"><strong>Call a pro for this one</strong>${list(s.reasons)}${s.hazards && s.hazards.length ? '<div style="margin-top:6px">Hazards: ' + s.hazards.map(esc).join(' · ') + '</div>' : ''}</div>`);
    }
    if (d.confidence === 'low') {
      parts.push(`<div class="lowconf"><strong>Low confidence.</strong> ${d.followUpQuestions && d.followUpQuestions.length ? 'Answering these would sharpen the diagnosis:' + list(d.followUpQuestions) : 'A clearer or closer photo would help.'}</div>`);
    }

    parts.push(`<h2>${esc(d.title)}</h2>`);
    const cost = d.estimatedCostUSD ? `${money(d.estimatedCostUSD.low)}–${money(d.estimatedCostUSD.high)}` : '';
    parts.push(`<div class="chips">
      <span class="chip ${esc(d.difficulty)}">${esc(d.difficulty || '?')}</span>
      <span class="chip">${esc(d.confidence || '?')} confidence</span>
      ${d.estimatedTime ? `<span class="chip">⏱ ${esc(d.estimatedTime)}</span>` : ''}
      ${cost ? `<span class="chip">${esc(cost)} DIY</span>` : ''}
    </div>`);

    parts.push(`<h3>Likely cause</h3><p>${esc(d.likelyCause)}</p>`);
    if (d.otherPossibilities && d.otherPossibilities.length) parts.push(`<h3>Could also be</h3>${list(d.otherPossibilities)}`);
    parts.push(`<div class="cols"><div><h3>Tools</h3>${list(d.tools)}</div><div><h3>Parts</h3>${list(d.parts)}</div></div>`);

    if (Array.isArray(d.steps) && d.steps.length) {
      parts.push('<h3>Steps</h3><ol class="steps">' + d.steps.map((st, i) => {
        const isDone = done.includes(i);
        const cb = fix ? `<input type="checkbox" data-act="step" data-id="${esc(fix.id)}" data-i="${i}" ${isDone ? 'checked' : ''} aria-label="Mark step ${i + 1} done">` : `<span class="step-num">${i + 1}</span>`;
        return `<li class="${isDone ? 'done' : ''}">${cb}<div class="s-body"><div class="s-title">${esc(st.step)}</div><div class="s-detail">${esc(st.detail)}</div>${st.caution ? `<div class="caution">⚠ ${esc(st.caution)}</div>` : ''}</div></li>`;
      }).join('') + '</ol>');
    }
    if (d.stopIf && d.stopIf.length) parts.push(`<h3>Stop and call a pro if</h3><div class="stop">${list(d.stopIf)}</div>`);
    return parts.join('');
  }

  function renderResult() {
    if (!current) return;
    $('#result').innerHTML = `<article class="card result">${diagnosisHTML(current.diagnosis)}
      <div class="actions">
        <button class="btn" id="save-fix">Save to my fixes</button>
        <button class="btn" id="new-diag">Start over</button>
      </div></article>`;
    $('#save-fix').addEventListener('click', saveCurrent);
    $('#new-diag').addEventListener('click', resetForm);
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resetForm() {
    current = null;
    clearPhoto();
    $('#desc').value = '';
    $('#room').value = '';
    $('#result').innerHTML = '';
    setStatus('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveCurrent() {
    if (!current) return;
    DATA.fixes.unshift({
      id: uid(),
      createdAt: new Date().toISOString(),
      status: 'Open',
      room: current.room,
      homeAge: current.homeAge,
      description: current.description,
      thumb: current.thumb,
      diagnosis: current.diagnosis,
      stepsDone: [],
    });
    const ok = await persist();
    if (!ok) { setStatus('Couldn’t save. Browser storage may be full.', true); DATA.fixes.shift(); return; }
    updateCount();
    resetForm();
    showTab('fixes');
  }

  // ---------- fixes list ----------
  const open = new Set();
  function updateCount() {
    const n = DATA.fixes.filter((f) => f.status !== 'Done').length;
    $('#fix-count').textContent = n ? `(${n})` : '';
  }

  function renderFixes() {
    const filter = $('#fix-filter').value;
    const items = DATA.fixes.filter((f) => filter === 'all' ? true : filter === 'Done' ? f.status === 'Done' : f.status !== 'Done');
    if (!items.length) {
      $('#fix-list').innerHTML = `<div class="card empty">${DATA.fixes.length ? 'Nothing here with this filter.' : 'No saved fixes yet. Diagnose something and save it here.'}</div>`;
      return;
    }
    $('#fix-list').innerHTML = items.map((f) => {
      const total = (f.diagnosis.steps || []).length;
      const pct = total ? Math.round(((f.stepsDone || []).length / total) * 100) : 0;
      const thumb = f.thumb ? `<img class="fix-thumb" src="${esc(f.thumb)}" alt="">` : '<div class="fix-thumb" aria-hidden="true">🔧</div>';
      const isOpen = open.has(f.id);
      return `<article class="card fix">
        ${thumb}
        <div>
          <h4>${f.diagnosis.safety && f.diagnosis.safety.callPro ? '🚩 ' : ''}${esc(f.diagnosis.title)}</h4>
          <div class="fix-meta">${esc(f.room || 'No room')} · ${new Date(f.createdAt).toLocaleDateString()} · ${(f.stepsDone || []).length}/${total} steps</div>
          <div class="bar"><span style="width:${pct}%"></span></div>
          <div class="fix-controls">
            <select data-act="status" data-id="${esc(f.id)}" aria-label="Status">
              ${['Open', 'In progress', 'Done'].map((s) => `<option ${s === f.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
            <button class="btn small" data-act="toggle" data-id="${esc(f.id)}">${isOpen ? 'Hide' : 'Open'}</button>
            <button class="link-btn" data-act="delete" data-id="${esc(f.id)}">Delete</button>
          </div>
        </div>
        ${isOpen ? `<div class="fix-detail result">${f.description ? `<h3>What you saw</h3><p>${esc(f.description)}</p>` : ''}${diagnosisHTML(f.diagnosis, { fix: f })}</div>` : ''}
      </article>`;
    }).join('');
  }

  $('#fix-filter').addEventListener('change', renderFixes);
  $('#fix-list').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const fix = DATA.fixes.find((f) => f.id === t.dataset.id);
    if (!fix) return;
    if (t.dataset.act === 'toggle') {
      open.has(fix.id) ? open.delete(fix.id) : open.add(fix.id);
      renderFixes();
    } else if (t.dataset.act === 'delete') {
      if (t.dataset.confirm !== '1') { t.dataset.confirm = '1'; t.textContent = 'Tap again to delete'; return; }
      DATA.fixes = DATA.fixes.filter((f) => f.id !== fix.id);
      await persist(); updateCount(); renderFixes();
    } else if (t.dataset.act === 'step') {
      const i = Number(t.dataset.i);
      const set = new Set(fix.stepsDone || []);
      t.checked ? set.add(i) : set.delete(i);
      fix.stepsDone = [...set].sort((a, b) => a - b);
      const total = (fix.diagnosis.steps || []).length;
      if (fix.status === 'Open' && fix.stepsDone.length) fix.status = 'In progress';
      if (total && fix.stepsDone.length === total) fix.status = 'Done';
      await persist(); updateCount(); renderFixes();
    }
  });
  $('#fix-list').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.act !== 'status') return;
    const fix = DATA.fixes.find((f) => f.id === t.dataset.id);
    if (!fix) return;
    fix.status = t.value;
    await persist(); updateCount(); renderFixes();
  });

  updateCount();
})();
