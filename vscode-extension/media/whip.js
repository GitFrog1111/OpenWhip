(function () {
  const vscode = acquireVsCodeApi();

  // ══════════════════════════════════════════════════════════════════════════
  //  PHYSICS SETTINGS
  // ══════════════════════════════════════════════════════════════════════════
  const P = {
    segments: 28,
    segmentLength: 25,
    taper: 0.6,

    gravity: 1.2,
    dropGravity: 0.95,
    damping: 0.96,
    constraintIters: 20,
    maxStretchRatio: 1.2,

    baseTargetAngle: -1.12,
    handleAimByMouseX: 0.4,
    handleAimByMouseY: 0.2,
    handleAimClamp: 2.0,
    handleSpring: 0.7,
    handleAngularDamping: 0.078,
    basePoseSegments: 2,
    basePoseStiffStart: 0.9,
    basePoseStiffEnd: 0.8,

    handleMaxBendDeg: 16,
    tipMaxBendDeg: 130,
    bendRigidityStart: 0.8,
    bendRigidityEnd: 0.12,

    wallBounce: 0.42,
    wallFriction: 0.86,

    crackSpeed: 270,
    crackCooldownMs: 200,
    firstCrackGraceMs: 350,

    lineWidthHandle: 7,
    lineWidthTip: 5,
    outlineWidth: 3,
    handleExtraWidth: 5,
    handleThickSegments: 2,
    arcWidth: 260,
    arcHeight: 185,
  };

  // ══════════════════════════════════════════════════════════════════════════

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  let W, H;

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  let mouseX = 0,
    mouseY = 0;
  let prevMouseX = 0,
    prevMouseY = 0;
  let whip = null;
  let dropping = false;
  let lastCrackTime = 0;
  let whipSpawnTime = 0;
  let handleAngle = P.baseTargetAngle;
  let handleAngVel = 0;

  const WHIP_CRACK_SOUNDS = window.SOUND_URIS || [];

  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });
  document.addEventListener('mousedown', () => {
    if (whip && !dropping) dropping = true;
  });

  // ── Whip creation ─────────────────────────────────────────────────────────
  function spawnWhip(mx, my) {
    dropping = false;
    lastCrackTime = 0;
    whipSpawnTime = Date.now();
    handleAngle = P.baseTargetAngle;
    handleAngVel = 0;
    const pts = [];
    for (let i = 0; i < P.segments; i++) {
      const t = i / (P.segments - 1);
      const x = mx + t * P.arcWidth;
      const y = my - Math.sin(t * Math.PI * 0.75) * P.arcHeight;
      pts.push({ x, y, px: x, py: y });
    }
    return pts;
  }

  function segLen(i) {
    const t = i / (P.segments - 1);
    return P.segmentLength * (1 - t * (1 - P.taper));
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  function catmullPoint(pts, i) {
    const n = pts.length;
    if (n === 0) return { x: 0, y: 0 };
    if (i < 0) {
      if (n >= 2) {
        return {
          x: 2 * pts[0].x - pts[1].x,
          y: 2 * pts[0].y - pts[1].y,
        };
      }
      return { x: pts[0].x, y: pts[0].y };
    }
    if (i >= n) {
      if (n >= 2) {
        const a = pts[n - 2],
          b = pts[n - 1];
        return { x: 2 * b.x - a.x, y: 2 * b.y - a.y };
      }
      return { x: pts[n - 1].x, y: pts[n - 1].y };
    }
    return pts[i];
  }

  function whipSegmentBezier(pts, i) {
    const p0 = catmullPoint(pts, i - 1);
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = catmullPoint(pts, i + 2);
    return {
      cp1x: p1.x + (p2.x - p0.x) / 6,
      cp1y: p1.y + (p2.y - p0.y) / 6,
      cp2x: p2.x - (p3.x - p1.x) / 6,
      cp2y: p2.y - (p3.y - p1.y) / 6,
      x2: p2.x,
      y2: p2.y,
    };
  }

  const wrapPi = (a) => {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  };

  function playCrackSound() {
    if (!WHIP_CRACK_SOUNDS.length) return;
    const src =
      WHIP_CRACK_SOUNDS[Math.floor(Math.random() * WHIP_CRACK_SOUNDS.length)];
    const a = new Audio(src);
    a.play().catch(() => {});
  }

  function updateHandleAim() {
    if (dropping) return;
    const mvx = mouseX - prevMouseX;
    const mvy = mouseY - prevMouseY;
    const delta = clamp(
      mvx * P.handleAimByMouseX + mvy * P.handleAimByMouseY,
      -P.handleAimClamp,
      P.handleAimClamp
    );
    const target = P.baseTargetAngle + delta;
    const err = wrapPi(target - handleAngle);
    handleAngVel += err * P.handleSpring;
    handleAngVel *= P.handleAngularDamping;
    handleAngle = wrapPi(handleAngle + handleAngVel);
  }

  function applyBasePose() {
    if (!whip || dropping) return;
    const dx = Math.cos(handleAngle);
    const dy = Math.sin(handleAngle);
    const guided = Math.min(P.basePoseSegments, whip.length - 1);
    for (let i = 1; i <= guided; i++) {
      const t = (i - 1) / Math.max(guided - 1, 1);
      const stiff = lerp(P.basePoseStiffStart, P.basePoseStiffEnd, t);
      const prev = whip[i - 1];
      const p = whip[i];
      const targetLen = segLen(i - 1);
      const tx = prev.x + dx * targetLen;
      const ty = prev.y + dy * targetLen;
      p.x = lerp(p.x, tx, stiff);
      p.y = lerp(p.y, ty, stiff);
    }
  }

  function applyBendLimits() {
    if (!whip || whip.length < 3) return;
    for (let i = 1; i < whip.length - 1; i++) {
      const a = whip[i - 1];
      const b = whip[i];
      const c = whip[i + 1];

      const v1x = a.x - b.x;
      const v1y = a.y - b.y;
      const v2x = c.x - b.x;
      const v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y) || 0.0001;
      const l2 = Math.hypot(v2x, v2y) || 0.0001;
      const n1x = v1x / l1,
        n1y = v1y / l1;
      const n2x = v2x / l2,
        n2y = v2y / l2;

      const dot = clamp(n1x * n2x + n1y * n2y, -1, 1);
      const angle = Math.acos(dot);
      const t = i / (whip.length - 2);
      const maxBend =
        (lerp(P.handleMaxBendDeg, P.tipMaxBendDeg, t) * Math.PI) / 180;
      const bend = Math.PI - angle;
      if (bend <= maxBend) continue;

      const cross = n1x * n2y - n1y * n2x;
      const sign = cross >= 0 ? 1 : -1;
      const targetAngle = Math.PI - maxBend;
      const targetA = Math.atan2(n1y, n1x) + sign * targetAngle;
      const tx = b.x + Math.cos(targetA) * l2;
      const ty = b.y + Math.sin(targetA) * l2;
      const rigidity = lerp(P.bendRigidityStart, P.bendRigidityEnd, t);

      c.x = lerp(c.x, tx, rigidity);
      c.y = lerp(c.y, ty, rigidity);
    }
  }

  function capSegmentStretch() {
    if (!whip || whip.length < 2) return;
    for (let i = 0; i < whip.length - 1; i++) {
      const a = whip[i];
      const b = whip[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.0001;
      const maxLen = segLen(i) * P.maxStretchRatio;
      if (dist <= maxLen) continue;
      const k = maxLen / dist;
      b.x = a.x + dx * k;
      b.y = a.y + dy * k;
    }
  }

  function applyWallCollisions() {
    if (!whip || dropping) return;
    const start = 1;
    for (let i = start; i < whip.length; i++) {
      const p = whip[i];
      let vx = p.x - p.px;
      let vy = p.y - p.py;
      let hit = false;

      if (p.x < 0) {
        p.x = 0;
        if (vx < 0) vx = -vx * P.wallBounce;
        vy *= P.wallFriction;
        hit = true;
      } else if (p.x > W) {
        p.x = W;
        if (vx > 0) vx = -vx * P.wallBounce;
        vy *= P.wallFriction;
        hit = true;
      }

      if (p.y < 0) {
        p.y = 0;
        if (vy < 0) vy = -vy * P.wallBounce;
        vx *= P.wallFriction;
        hit = true;
      } else if (p.y > H) {
        p.y = H;
        if (vy > 0) vy = -vy * P.wallBounce;
        vx *= P.wallFriction;
        hit = true;
      }

      if (hit) {
        p.px = p.x - vx;
        p.py = p.y - vy;
      }
    }
  }

  // ── Physics step ──────────────────────────────────────────────────────────
  function update() {
    if (!whip) return;

    const g = dropping ? P.dropGravity : P.gravity;
    updateHandleAim();

    const start = dropping ? 0 : 1;
    for (let i = start; i < whip.length; i++) {
      const p = whip[i];
      const vx = (p.x - p.px) * P.damping;
      const vy = (p.y - p.py) * P.damping;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + g;
    }

    if (!dropping) {
      whip[0].x = mouseX;
      whip[0].y = mouseY;
      whip[0].px = mouseX;
      whip[0].py = mouseY;
    }

    capSegmentStretch();
    applyWallCollisions();
    applyBasePose();

    for (let iter = 0; iter < P.constraintIters; iter++) {
      for (let i = 0; i < whip.length - 1; i++) {
        const a = whip[i],
          b = whip[i + 1];
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        const target = segLen(i);
        const diff = ((dist - target) / dist) * 0.5;
        const ox = dx * diff,
          oy = dy * diff;
        if (i === 0 && !dropping) {
          b.x -= ox * 2;
          b.y -= oy * 2;
        } else {
          a.x += ox;
          a.y += oy;
          b.x -= ox;
          b.y -= oy;
        }
      }
      applyBendLimits();
      if (!dropping) applyBasePose();
      capSegmentStretch();
      applyWallCollisions();
    }

    const tip = whip[whip.length - 1];
    const tipVel = Math.hypot(tip.x - tip.px, tip.y - tip.py);

    if (!dropping && tipVel > P.crackSpeed) {
      const now = Date.now();
      if (
        now - whipSpawnTime >= P.firstCrackGraceMs &&
        now - lastCrackTime > P.crackCooldownMs
      ) {
        lastCrackTime = now;
        playCrackSound();
        vscode.postMessage({ type: 'whip-crack' });
      }
    }

    if (dropping && whip.every((p) => p.y > H + 60)) {
      whip = null;
      dropping = false;
      vscode.postMessage({ type: 'hide-overlay' });
    }
    prevMouseX = mouseX;
    prevMouseY = mouseY;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  function draw() {
    ctx.clearRect(0, 0, W, H);

    if (!whip) return;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff';
    if (whip.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(whip[0].x, whip[0].y);
      for (let i = 0; i < whip.length - 1; i++) {
        const { cp1x, cp1y, cp2x, cp2y, x2, y2 } = whipSegmentBezier(
          whip,
          i
        );
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
      }
      ctx.lineWidth = P.lineWidthTip + P.outlineWidth * 2;
      ctx.stroke();

      const thickLinks = Math.min(P.handleThickSegments, whip.length - 1);
      if (thickLinks > 0 && P.handleExtraWidth > 0) {
        ctx.beginPath();
        ctx.moveTo(whip[0].x, whip[0].y);
        for (let i = 0; i < thickLinks; i++) {
          const { cp1x, cp1y, cp2x, cp2y, x2, y2 } = whipSegmentBezier(
            whip,
            i
          );
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
        }
        ctx.lineWidth =
          P.lineWidthHandle + P.handleExtraWidth + P.outlineWidth * 2;
        ctx.stroke();
      }
    }

    ctx.strokeStyle = '#111';
    for (let i = 0; i < whip.length - 1; i++) {
      const t = i / Math.max(1, whip.length - 2);
      const extra = i < P.handleThickSegments ? P.handleExtraWidth : 0;
      ctx.lineWidth = lerp(P.lineWidthHandle, P.lineWidthTip, t) + extra;
      const { cp1x, cp1y, cp2x, cp2y, x2, y2 } = whipSegmentBezier(whip, i);
      ctx.beginPath();
      ctx.moveTo(whip[i].x, whip[i].y);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
      ctx.stroke();
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────────────
  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  // ── Messages from the extension host ──────────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'spawn-whip') {
      whip = spawnWhip(mouseX || W / 2, mouseY || H / 2);
      dropping = false;
      prevMouseX = mouseX;
      prevMouseY = mouseY;
    } else if (msg.type === 'drop-whip') {
      if (whip && !dropping) dropping = true;
    }
  });

  // Auto-spawn on load
  whip = spawnWhip(W / 2, H / 2);
  prevMouseX = W / 2;
  prevMouseY = H / 2;
  loop();
})();
