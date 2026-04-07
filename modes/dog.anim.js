(function() {
  'use strict';

  if (!window.animRegistry) {
    console.warn('animRegistry not found — dog animations not loaded');
    return;
  }

  // ---------------------------------------------------------------------------
  // Utility: generate a lightning bolt via midpoint displacement
  // ---------------------------------------------------------------------------
  function generateBolt(x1, y1, x2, y2, depth) {
    if (depth === 0) return [{ x: x1, y: y1 }, { x: x2, y: y2 }];
    var dist = Math.hypot(x2 - x1, y2 - y1);
    var midX = (x1 + x2) / 2 + (Math.random() - 0.5) * dist * 0.3;
    var midY = (y1 + y2) / 2 + (Math.random() - 0.5) * dist * 0.3;
    var left = generateBolt(x1, y1, midX, midY, depth - 1);
    var right = generateBolt(midX, midY, x2, y2, depth - 1);
    return left.concat(right.slice(1));
  }

  // ---------------------------------------------------------------------------
  // Utility: random edge point on screen
  // ---------------------------------------------------------------------------
  function randomEdgePoint(W, H) {
    var edge = Math.floor(Math.random() * 4);
    switch (edge) {
      case 0: return { x: Math.random() * W, y: 0 };          // top
      case 1: return { x: W, y: Math.random() * H };           // right
      case 2: return { x: Math.random() * W, y: H };           // bottom
      default: return { x: 0, y: Math.random() * H };          // left
    }
  }

  // ---------------------------------------------------------------------------
  // dog-leash — Yank Leash
  // ---------------------------------------------------------------------------
  window.animRegistry.register('dog-leash', {
    create: function(cx, cy, W, H) {
      return {
        startTime: Date.now(),
        cx: cx,
        cy: cy,
        claudeX: cx + 400,
        claudeY: cy,
        triggered: false
      };
    },

    draw: function(ctx, state, W, H) {
      var elapsed = Date.now() - state.startTime;
      if (elapsed >= 900) return false;

      ctx.save();

      // --- Screen flash: yellow/orange overlay peaking at 200ms ---
      if (elapsed < 400) {
        var flashT = elapsed / 200;
        var flashAlpha;
        if (flashT <= 1) {
          flashAlpha = 0.3 * flashT;
        } else {
          flashAlpha = 0.3 * (1 - (elapsed - 200) / 200);
        }
        if (flashAlpha > 0) {
          ctx.fillStyle = 'rgba(255, 165, 0, ' + Math.max(0, flashAlpha) + ')';
          ctx.fillRect(0, 0, W, H);
        }
      }

      var cx = state.cx;
      var cy = state.cy;

      if (elapsed < 400) {
        // Phase 1: yank — claude-point moves toward cursor with ease-out
        var t = elapsed / 400;
        var ease = 1 - Math.pow(1 - t, 3);
        var curClaudeX = state.claudeX - (state.claudeX - cx) * ease;
        var curClaudeY = state.claudeY - (state.claudeY - cy) * ease;

        // Midpoint sag decreases as line goes taut
        var midX = (cx + curClaudeX) / 2;
        var midY = (cy + curClaudeY) / 2 + 80 * (1 - ease);

        // Outer rope (lighter outline)
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(midX, midY, curClaudeX, curClaudeY);
        ctx.strokeStyle = '#8B6914';
        ctx.lineWidth = 12;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Inner rope (dark brown)
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(midX, midY, curClaudeX, curClaudeY);
        ctx.strokeStyle = '#5C3317';
        ctx.lineWidth = 8;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Handle circle at cursor
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fillStyle = '#8B6914';
        ctx.fill();
        ctx.strokeStyle = '#5C3317';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Collar circle at claude-point
        ctx.beginPath();
        ctx.arc(curClaudeX, curClaudeY, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#C0392B';
        ctx.fill();
        ctx.strokeStyle = '#922B21';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Trigger at 200ms
        if (elapsed >= 200 && !state.triggered) {
          state.triggered = true;
        }
      } else {
        // Phase 2 (400-900ms): rope goes slack, fades out
        var t2 = (elapsed - 400) / 500;
        var fadeAlpha = 1 - t2;

        ctx.globalAlpha = Math.max(0, fadeAlpha);

        // Slack midpoint sags with gravity
        var sagY = cy + 120 * t2;
        var midX2 = (cx + cx) / 2; // claude is now at cursor
        var midY2 = (cy + cy) / 2 + 40 + 120 * t2;

        // Outer rope
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(cx, midY2, cx + 20, cy + 10);
        ctx.strokeStyle = '#8B6914';
        ctx.lineWidth = 12;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Inner rope
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(cx, midY2, cx + 20, cy + 10);
        ctx.strokeStyle = '#5C3317';
        ctx.lineWidth = 8;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Handle
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fillStyle = '#8B6914';
        ctx.fill();

        ctx.globalAlpha = 1;
      }

      ctx.restore();
      return true;
    }
  });

  // ---------------------------------------------------------------------------
  // dog-pet — Pet Good Dog
  // ---------------------------------------------------------------------------
  window.animRegistry.register('dog-pet', {
    create: function(cx, cy, W, H) {
      var rings = [];
      for (var i = 0; i < 4; i++) {
        rings.push({ delay: i * 100 });
      }
      return {
        startTime: Date.now(),
        cx: cx,
        cy: cy,
        rings: rings,
        triggered: false
      };
    },

    draw: function(ctx, state, W, H) {
      var elapsed = Date.now() - state.startTime;
      if (elapsed >= 800) return false;

      ctx.save();

      // --- Screen glow: gentle green pulse ---
      var pulseT = elapsed / 800;
      var glowAlpha = 0.05 + 0.1 * (0.5 + 0.5 * Math.sin(pulseT * Math.PI * 4));
      ctx.fillStyle = 'rgba(100, 255, 100, ' + glowAlpha + ')';
      ctx.fillRect(0, 0, W, H);

      var cx = state.cx;
      var cy = state.cy;

      // --- Expanding concentric rings ---
      for (var i = 0; i < state.rings.length; i++) {
        var ring = state.rings[i];
        var ringElapsed = elapsed - ring.delay;
        if (ringElapsed < 0) continue;

        var ringDuration = 800 - ring.delay;
        var rt = Math.min(1, ringElapsed / ringDuration);
        var easeRT = 1 - Math.pow(1 - rt, 3); // ease-out

        var radius = 20 + (150 - 20) * easeRT;
        var alpha = 0.6 * (1 - easeRT);

        if (alpha > 0.001) {
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(100, 200, 100, ' + alpha + ')';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }

      // --- Hand emoji with bobbing motion ---
      var bobOffset = 5 * Math.sin(elapsed / 100 * Math.PI);
      ctx.font = '48px serif';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText('\u270B', cx - 24, cy + 16 + bobOffset);

      // Trigger at 200ms
      if (elapsed >= 200 && !state.triggered) {
        state.triggered = true;
      }

      ctx.restore();
      return true;
    }
  });

  // ---------------------------------------------------------------------------
  // dog-zap — Zap Collar / Electric Shock
  // ---------------------------------------------------------------------------
  window.animRegistry.register('dog-zap', {
    create: function(cx, cy, W, H) {
      var bolts = [];
      for (var i = 0; i < 4; i++) {
        var edge = randomEdgePoint(W, H);
        bolts.push(generateBolt(edge.x, edge.y, cx, cy, 5));
      }
      return {
        startTime: Date.now(),
        cx: cx,
        cy: cy,
        bolts: bolts,
        triggered: false
      };
    },

    draw: function(ctx, state, W, H) {
      var elapsed = Date.now() - state.startTime;
      if (elapsed >= 500) return false;

      ctx.save();

      // --- Red strobe flashes: 0-60ms, 100-160ms, 220-280ms ---
      var flashing = (elapsed >= 0 && elapsed < 60) ||
                     (elapsed >= 100 && elapsed < 160) ||
                     (elapsed >= 220 && elapsed < 280);
      if (flashing) {
        ctx.fillStyle = 'rgba(255, 0, 0, 0.4)';
        ctx.fillRect(0, 0, W, H);
      }

      // --- Fade out in last 150ms ---
      var boltAlpha = 1;
      if (elapsed > 350) {
        boltAlpha = 1 - (elapsed - 350) / 150;
        boltAlpha = Math.max(0, boltAlpha);
      }

      ctx.globalAlpha = boltAlpha;

      // --- Draw lightning bolts ---
      for (var b = 0; b < state.bolts.length; b++) {
        var bolt = state.bolts[b];

        // Outer glow pass
        ctx.beginPath();
        for (var p = 0; p < bolt.length; p++) {
          var jx = bolt[p].x + (Math.random() - 0.5) * 4;
          var jy = bolt[p].y + (Math.random() - 0.5) * 4;
          if (p === 0) {
            ctx.moveTo(jx, jy);
          } else {
            ctx.lineTo(jx, jy);
          }
        }
        ctx.strokeStyle = '#00FFFF';
        ctx.lineWidth = 4;
        ctx.shadowColor = '#00FFFF';
        ctx.shadowBlur = 30;
        ctx.stroke();

        // Inner core pass
        ctx.beginPath();
        for (var q = 0; q < bolt.length; q++) {
          var jx2 = bolt[q].x + (Math.random() - 0.5) * 4;
          var jy2 = bolt[q].y + (Math.random() - 0.5) * 4;
          if (q === 0) {
            ctx.moveTo(jx2, jy2);
          } else {
            ctx.lineTo(jx2, jy2);
          }
        }
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.shadowColor = '#FFFFFF';
        ctx.shadowBlur = 15;
        ctx.stroke();

        // Reset shadow for next iteration
        ctx.shadowBlur = 0;
      }

      // --- Impact glow at cursor ---
      var cx = state.cx;
      var cy = state.cy;
      var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 80);
      grad.addColorStop(0, 'rgba(255, 255, 255, ' + (0.8 * boltAlpha) + ')');
      grad.addColorStop(0.5, 'rgba(0, 255, 255, ' + (0.4 * boltAlpha) + ')');
      grad.addColorStop(1, 'rgba(0, 255, 255, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, 80, 0, Math.PI * 2);
      ctx.fill();

      // --- Zap emoji at cursor ---
      ctx.shadowBlur = 0;
      ctx.font = '48px serif';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText('\u26A1', cx - 24, cy + 16);

      // Trigger at 100ms
      if (elapsed >= 100 && !state.triggered) {
        state.triggered = true;
      }

      ctx.globalAlpha = 1;
      ctx.restore();
      return true;
    }
  });

})();
