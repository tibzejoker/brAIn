import { useEffect, useRef } from "react";

/**
 * Ambient page background — two slow-drifting, heavily-blurred purple
 * orbs (pure CSS, GPU-only) plus a sparse dot grid (canvas 2D) where
 * dots slip away from the cursor.
 *
 * Performance:
 *   - Orbs are CSS keyframes on `transform` only → composited, no
 *     paint cost per frame.
 *   - The canvas only redraws while the mouse is moving; ~600ms after
 *     the last move it settles back to the rest grid and the rAF loop
 *     stops entirely — idle CPU is zero.
 *   - Honors `prefers-reduced-motion`: orbs stop drifting and dots
 *     stop following the cursor.
 *
 * Sits behind everything via `-z-10` + `pointer-events-none`. The
 * surrounding chrome (header, side menu, panels) is opaque, so the FX
 * shows through gaps and through the (transparent) React Flow pane.
 */
export function BackgroundFX(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasNullable = canvasRef.current;
    if (!canvasNullable) return;
    const ctxNullable = canvasNullable.getContext("2d", { alpha: true });
    if (!ctxNullable) return;
    // TS loses narrowing across nested function declarations — alias to
    // non-null locals so `draw`, `onMove` etc. can use them directly.
    const canvas: HTMLCanvasElement = canvasNullable;
    const ctx: CanvasRenderingContext2D = ctxNullable;

    const SPACING = 36;
    const REPULSE_RADIUS = 320;
    const MAX_DISPLACE = 18;
    const DOT_RADIUS = 1.1;
    const DOT_COLOR = "rgba(180, 180, 195, 0.22)";
    const IDLE_MS = 600;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let dpr = window.devicePixelRatio || 1;
    let width = 0;
    let height = 0;
    let dots: { x: number; y: number }[] = [];
    let mouseX = -9999;
    let mouseY = -9999;
    let mouseActive = false;
    let lastMoveTs = 0;
    let rafId = 0;

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
          dots.push({ x: c * SPACING, y: r * SPACING });
        }
      }
    }

    function draw(): void {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = DOT_COLOR;
      const active = mouseActive && !reducedMotion;
      const r2 = REPULSE_RADIUS * REPULSE_RADIUS;
      for (const d of dots) {
        let x = d.x;
        let y = d.y;
        if (active) {
          const dx = d.x - mouseX;
          const dy = d.y - mouseY;
          const distSq = dx * dx + dy * dy;
          if (distSq < r2 && distSq > 0.01) {
            const dist = Math.sqrt(distSq);
            const t = 1 - dist / REPULSE_RADIUS;
            const push = MAX_DISPLACE * t * t;
            x += (dx / dist) * push;
            y += (dy / dist) * push;
          }
        }
        ctx.beginPath();
        ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function tick(): void {
      draw();
      if (performance.now() - lastMoveTs > IDLE_MS) {
        if (mouseActive) {
          mouseActive = false;
          rafId = requestAnimationFrame(tick);
          return;
        }
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
      mouseActive = true;
      lastMoveTs = performance.now();
      startLoop();
    }

    function onLeave(): void {
      lastMoveTs = 0;
    }

    function onResize(): void {
      dpr = window.devicePixelRatio || 1;
      setupDots();
      draw();
    }

    setupDots();
    draw();
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mouseout", onLeave, { passive: true });
    window.addEventListener("resize", onResize);
    return (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onLeave);
      window.removeEventListener("resize", onResize);
      if (rafId) cancelAnimationFrame(rafId);
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
