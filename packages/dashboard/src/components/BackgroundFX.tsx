import { useEffect, useRef } from "react";

/**
 * Ambient page background — two slow-drifting, heavily-blurred purple
 * orbs (pure CSS, GPU-only) plus a sparse dot grid (canvas 2D) where:
 *   - Dots slip away from the cursor with eased ramp-in / ramp-out.
 *   - Periodically, glowing "synapse" sparks fire across short hops in
 *     the grid, lighting up the source and target dots and tracing a
 *     thin trail between them.
 *
 * Performance:
 *   - Orbs are CSS keyframes on `transform` only → composited, no
 *     paint cost per frame.
 *   - The canvas rAF loop only runs while the mouse is active, dots
 *     are still settling, or a spark is in flight. When everything
 *     calms down it stops entirely (idle CPU = 0). Sparks self-schedule
 *     via setTimeout so the loop wakes up just long enough to play one
 *     out, then sleeps again.
 *   - Honors `prefers-reduced-motion`: orbs static, dots inert, no
 *     synapse sparks fired.
 *
 * Sits behind everything via `position: fixed; z-index: 0` +
 * `pointer-events-none`. The surrounding chrome (header, side menu,
 * panels) is opaque, so the FX shows through gaps and through the
 * (transparent) React Flow pane.
 */
export function BackgroundFX(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasNullable = canvasRef.current;
    if (!canvasNullable) return;
    const ctxNullable = canvasNullable.getContext("2d", { alpha: true });
    if (!ctxNullable) return;
    // TS loses narrowing across nested function declarations — alias to
    // non-null locals so the inner functions can use them directly.
    const canvas: HTMLCanvasElement = canvasNullable;
    const ctx: CanvasRenderingContext2D = ctxNullable;

    // === Dot grid ===
    const SPACING = 36;
    const REPULSE_RADIUS = 320;
    const MAX_DISPLACE = 18;
    const DOT_RADIUS = 1.1;
    const DOT_COLOR = "rgba(180, 180, 195, 0.22)";
    const IDLE_MS = 180;
    const EASE = 0.18;
    const SETTLE_EPSILON = 0.05;

    // === Synapse sparks ===
    // A spark hops between two nearby dots, tracing a faint trail and
    // lighting up the endpoints. Distance band picks neighbours that
    // are close enough to read as "connected" but not on top of each
    // other.
    const SPARK_MIN_DIST = 50;
    const SPARK_MAX_DIST = 200;
    const SPARK_DURATION_MIN = 700;
    const SPARK_DURATION_MAX = 1100;
    // Schedule the next spark this many ms after the previous one
    // fires. Stochastic to avoid a metronome feel.
    const SPARK_INTERVAL_MIN = 600;
    const SPARK_INTERVAL_MAX = 1800;
    // How long an endpoint dot stays "lit" after the spark touches it.
    const ENDPOINT_FLASH_MS = 450;
    // Cool-white spark colour with a soft blue glow — reads as
    // electrical activity against the warm-neutral dot grid.
    const SPARK_CORE = "rgba(235, 240, 255, ";
    const SPARK_GLOW = "rgba(150, 180, 255, 0.55)";
    const TRAIL_COLOR = "rgba(180, 200, 255, ";

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let dpr = window.devicePixelRatio || 1;
    let width = 0;
    let height = 0;
    // hx,hy = home (rest) position; dx,dy = current displacement from
    // home (eased toward target each tick); litUntil = `performance.now()`
    // until which this dot renders as a brighter "lit" version due to a
    // synapse spark touching it.
    let dots: { hx: number; hy: number; dx: number; dy: number; litUntil: number }[] = [];
    let mouseX = -9999;
    let mouseY = -9999;
    let lastMoveTs = 0;
    let rafId = 0;

    type Spark = {
      fromIdx: number;
      toIdx: number;
      startTs: number;
      duration: number;
    };
    let sparks: Spark[] = [];
    let sparkTimer: number | null = null;

    function setupDots(): void {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = [];
      const cols = Math.ceil(width / SPACING) + 1;
      const rows = Math.ceil(height / SPACING) + 1;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          dots.push({ hx: c * SPACING, hy: r * SPACING, dx: 0, dy: 0, litUntil: 0 });
        }
      }
    }

    function spawnSpark(): void {
      scheduleNextSpark();
      if (reducedMotion || dots.length < 2) return;
      // Pick a random source, then a random target within the dist band.
      const fromIdx = Math.floor(Math.random() * dots.length);
      const from = dots[fromIdx];
      const candidates: number[] = [];
      const minSq = SPARK_MIN_DIST * SPARK_MIN_DIST;
      const maxSq = SPARK_MAX_DIST * SPARK_MAX_DIST;
      for (let i = 0; i < dots.length; i++) {
        if (i === fromIdx) continue;
        const dx = dots[i].hx - from.hx;
        const dy = dots[i].hy - from.hy;
        const distSq = dx * dx + dy * dy;
        if (distSq >= minSq && distSq <= maxSq) candidates.push(i);
      }
      if (candidates.length === 0) return;
      const toIdx = candidates[Math.floor(Math.random() * candidates.length)];
      const now = performance.now();
      sparks.push({
        fromIdx,
        toIdx,
        startTs: now,
        duration: SPARK_DURATION_MIN + Math.random() * (SPARK_DURATION_MAX - SPARK_DURATION_MIN),
      });
      // Light the source on departure; the target gets lit when the
      // spark actually reaches it (in step()).
      dots[fromIdx].litUntil = now + ENDPOINT_FLASH_MS;
      startLoop();
    }

    function scheduleNextSpark(): void {
      if (sparkTimer !== null) return;
      const delay = SPARK_INTERVAL_MIN + Math.random() * (SPARK_INTERVAL_MAX - SPARK_INTERVAL_MIN);
      sparkTimer = window.setTimeout(() => {
        sparkTimer = null;
        spawnSpark();
      }, delay);
    }

    function step(): boolean {
      const now = performance.now();
      const active = !reducedMotion && (now - lastMoveTs) < IDLE_MS;
      const r2 = REPULSE_RADIUS * REPULSE_RADIUS;
      let stillMoving = false;

      ctx.clearRect(0, 0, width, height);

      // --- Dot grid (with eased mouse repulsion + endpoint flashes) ---
      for (const d of dots) {
        let tx = 0;
        let ty = 0;
        if (active) {
          const ax = d.hx - mouseX;
          const ay = d.hy - mouseY;
          const distSq = ax * ax + ay * ay;
          if (distSq < r2 && distSq > 0.01) {
            const dist = Math.sqrt(distSq);
            const k = 1 - dist / REPULSE_RADIUS;
            const push = MAX_DISPLACE * k * k;
            tx = (ax / dist) * push;
            ty = (ay / dist) * push;
          }
        }
        d.dx += (tx - d.dx) * EASE;
        d.dy += (ty - d.dy) * EASE;
        if (Math.abs(d.dx) > SETTLE_EPSILON || Math.abs(d.dy) > SETTLE_EPSILON) {
          stillMoving = true;
        } else if (!active) {
          d.dx = 0;
          d.dy = 0;
        }
        // Endpoint flash: fade from full lit → base over ENDPOINT_FLASH_MS.
        const litLeft = d.litUntil - now;
        if (litLeft > 0) {
          stillMoving = true;
          const flashT = litLeft / ENDPOINT_FLASH_MS;
          // Lit dot — bigger, brighter, soft glow.
          ctx.shadowColor = SPARK_GLOW;
          ctx.shadowBlur = 10 * flashT;
          ctx.fillStyle = SPARK_CORE + (0.85 * flashT + 0.22).toFixed(3) + ")";
          ctx.beginPath();
          ctx.arc(d.hx + d.dx, d.hy + d.dy, DOT_RADIUS + 1.5 * flashT, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        } else {
          ctx.fillStyle = DOT_COLOR;
          ctx.beginPath();
          ctx.arc(d.hx + d.dx, d.hy + d.dy, DOT_RADIUS, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // --- Synapse sparks ---
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        const t = (now - s.startTs) / s.duration;
        if (t >= 1) {
          // Arrived — light the target on the way out. Indices are
          // guaranteed valid because sparks are cleared on resize
          // (which is the only way `dots` is rebuilt).
          const to = dots[s.toIdx];
          to.litUntil = Math.max(to.litUntil, now + ENDPOINT_FLASH_MS);
          sparks.splice(i, 1);
          continue;
        }
        const from = dots[s.fromIdx];
        const to = dots[s.toIdx];
        // Ease-out cubic so the spark accelerates then arrives gently.
        const ease = 1 - Math.pow(1 - t, 3);
        const fx = from.hx + from.dx;
        const fy = from.hy + from.dy;
        const tox = to.hx + to.dx;
        const toy = to.hy + to.dy;
        const x = fx + (tox - fx) * ease;
        const y = fy + (toy - fy) * ease;
        // Trail: thin line from origin to current head, fading along.
        ctx.strokeStyle = TRAIL_COLOR + (0.35 * (1 - Math.abs(t - 0.5) * 2)).toFixed(3) + ")";
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(x, y);
        ctx.stroke();
        // Head: glowing dot at the leading edge. Brightness peaks
        // mid-flight then dims as it lands.
        const headAlpha = Math.sin(t * Math.PI);
        ctx.shadowColor = SPARK_GLOW;
        ctx.shadowBlur = 14 * headAlpha;
        ctx.fillStyle = SPARK_CORE + (0.95 * headAlpha).toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      return stillMoving || active || sparks.length > 0;
    }

    function tick(): void {
      const keepRunning = step();
      if (!keepRunning) {
        rafId = 0;
        return;
      }
      rafId = requestAnimationFrame(tick);
    }

    function startLoop(): void {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(tick);
    }

    function onMove(e: MouseEvent): void {
      const rect = canvas.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
      lastMoveTs = performance.now();
      startLoop();
    }

    function onLeave(): void {
      lastMoveTs = 0;
      startLoop();
    }

    function onResize(): void {
      dpr = window.devicePixelRatio || 1;
      // Drop in-flight sparks — their indices reference the OLD `dots`
      // array and would be stale after the rebuild.
      sparks = [];
      setupDots();
      step();
    }

    setupDots();
    step();
    scheduleNextSpark();
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mouseout", onLeave, { passive: true });
    window.addEventListener("resize", onResize);
    return (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onLeave);
      window.removeEventListener("resize", onResize);
      if (rafId) cancelAnimationFrame(rafId);
      if (sparkTimer !== null) {
        clearTimeout(sparkTimer);
        sparkTimer = null;
      }
      sparks = [];
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 pointer-events-none overflow-hidden"
      style={{ zIndex: 0 }}
    >
      <div className="bg-orb bg-orb-a" />
      <div className="bg-orb bg-orb-b" />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
      />
    </div>
  );
}
