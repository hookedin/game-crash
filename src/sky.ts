import type { FlightView } from './rules.ts';
import { MAX_MULTIPLIER } from './rules.ts';

/** All movement is presentation. Only the room decides the flight and the wallet decides what was paid. */
export function createSky(canvas: HTMLCanvasElement, reduced: boolean) {
  const context = canvas.getContext('2d')!;
  let width = 0,
    height = 0,
    endedAt = 0,
    lastPhase = '',
    burstAt = -Infinity;
  const stars = Array.from({ length: 65 }, (_, i) => ({
    x: ((i * 137.508) % 997) / 997,
    y: ((i * 71.17) % 941) / 941,
    size: i % 4 === 0 ? 1.3 : 0.7,
  }));

  function resize() {
    const box = canvas.getBoundingClientRect(),
      scale = Math.min(devicePixelRatio || 1, 2);
    if (box.width === width && box.height === height) return;
    width = box.width;
    height = box.height;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function rocket(x: number, y: number, angle: number, time: number, flying: boolean) {
    const c = context;
    c.save();
    c.translate(x, y);
    c.rotate(angle);
    c.scale(width < 500 ? 1.15 : 1.5, width < 500 ? 1.15 : 1.5);
    if (flying || !reduced) {
      const flame = flying ? 51 + Math.sin(time / 43) * 10 : 22 + Math.sin(time / 180) * 5;
      c.shadowColor = '#ff873e';
      c.shadowBlur = 20;
      c.fillStyle = '#ff692f';
      c.beginPath();
      c.moveTo(-25, -10);
      c.quadraticCurveTo(-40, -17, -flame - 27, 0);
      c.quadraticCurveTo(-40, 17, -25, 10);
      c.fill();
      c.fillStyle = '#ffd9a1';
      c.beginPath();
      c.moveTo(-25, -5);
      c.lineTo(-flame * 0.58 - 27, 0);
      c.lineTo(-25, 5);
      c.fill();
      c.shadowBlur = 0;
    }
    c.fillStyle = '#ff7c43';
    c.beginPath();
    c.moveTo(-24, -9);
    c.lineTo(-30, -29);
    c.lineTo(-4, -15);
    c.lineTo(4, 0);
    c.lineTo(-4, 15);
    c.lineTo(-30, 29);
    c.lineTo(-24, 9);
    c.fill();
    const hull = c.createLinearGradient(0, -16, 0, 17);
    hull.addColorStop(0, '#fff7e8');
    hull.addColorStop(0.55, '#dce0de');
    hull.addColorStop(1, '#7f9099');
    c.fillStyle = hull;
    c.beginPath();
    c.moveTo(-26, -12);
    c.quadraticCurveTo(17, -23, 47, 0);
    c.quadraticCurveTo(17, 23, -26, 12);
    c.closePath();
    c.fill();
    c.fillStyle = '#f28b50';
    c.beginPath();
    c.moveTo(23, -13);
    c.quadraticCurveTo(39, -7, 47, 0);
    c.quadraticCurveTo(39, 7, 23, 13);
    c.quadraticCurveTo(29, 0, 23, -13);
    c.fill();
    c.fillStyle = '#42505a';
    c.beginPath();
    c.arc(8, 0, 10, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#a5e4df';
    c.beginPath();
    c.arc(8, 0, 6.6, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#efffff';
    c.beginPath();
    c.arc(9, -2, 2.1, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#454d53';
    c.fillRect(-29, -9, 6, 18);
    c.strokeStyle = '#68777f';
    c.lineWidth = 0.7;
    c.beginPath();
    c.moveTo(-14, -13);
    c.lineTo(-14, 13);
    c.stroke();
    c.restore();
  }

  return {
    celebrate() {
      burstAt = performance.now();
    },
    draw(view: FlightView | null, multiplier: number, time: number) {
      resize();
      const c = context,
        phase = view?.phase ?? 'boarding';
      if (phase === 'ended' && lastPhase !== phase) endedAt = time;
      lastPhase = phase;
      c.clearRect(0, 0, width, height);
      const progress = Math.max(0, Math.min(1, Math.log(multiplier / 100) / Math.log(100)));
      // A quiet coordinate grid and a planet below the launch pad.
      c.strokeStyle = '#30364355';
      c.lineWidth = 1;
      for (let y = 75; y < height - 40; y += 55) {
        c.beginPath();
        c.moveTo(22, y);
        c.lineTo(width - 22, y);
        c.stroke();
      }
      for (let x = 30; x < width; x += 70) {
        c.beginPath();
        c.moveTo(x, 62);
        c.lineTo(x, height - 41);
        c.stroke();
      }
      for (const star of stars) {
        const drift = !reduced && phase === 'flying' ? (time / 35) % width : 0;
        const x = (star.x * width - drift + width) % width,
          y = 54 + star.y * (height - 110);
        c.fillStyle = star.size > 1 ? '#c6b49b77' : '#7887a55c';
        c.fillRect(x, y, star.size, star.size);
      }
      c.save();
      c.strokeStyle = '#45444f5a';
      c.lineWidth = 1;
      c.beginPath();
      c.ellipse(width * 0.88, height * 1.47, width * 0.74, height * 0.68, -0.3, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.ellipse(width * 0.88, height * 1.47, width * 0.76, height * 0.7, -0.3, 0, Math.PI * 2);
      c.stroke();
      c.restore();
      const x = width * (0.62 + progress * 0.23),
        y = height * (0.7 - progress * 0.43);
      const cx = width * 0.42,
        cy = height * 0.88;
      c.beginPath();
      c.moveTo(25, height - 57);
      c.bezierCurveTo(width * 0.25, height - 57, cx, cy, x, y);
      c.strokeStyle = phase === 'ended' ? '#a95b445c' : '#ff8757';
      c.lineWidth = 2;
      c.shadowColor = '#ff7d43';
      c.shadowBlur = phase === 'flying' ? 14 : 0;
      c.stroke();
      c.shadowBlur = 0;
      c.lineTo(x, height - 57);
      c.lineTo(25, height - 57);
      c.closePath();
      const fill = c.createLinearGradient(0, y, 0, height - 50);
      fill.addColorStop(0, '#ff7d431b');
      fill.addColorStop(1, '#ff7d4300');
      c.fillStyle = fill;
      c.fill();
      if (phase !== 'ended' || view?.point === MAX_MULTIPLIER) {
        const bob = reduced || phase === 'flying' ? 0 : Math.sin(time / 800) * 4;
        rocket(x, y + bob, -0.45 - progress * 0.2, reduced ? 0 : time, phase === 'flying');
        if (phase === 'boarding') {
          c.strokeStyle = '#ff985036';
          c.setLineDash([3, 8]);
          c.beginPath();
          c.ellipse(x, y + 25, 58, 19, 0, 0, Math.PI * 2);
          c.stroke();
          c.setLineDash([]);
        }
      } else {
        const age = reduced ? 1 : Math.min(1, (time - endedAt) / 1400);
        c.strokeStyle = `rgba(255,130,77,${(1 - age) * 0.7})`;
        c.lineWidth = 2;
        c.beginPath();
        c.arc(x, y, 8 + age * 90, 0, Math.PI * 2);
        c.stroke();
        c.fillStyle = '#ff996b';
        c.beginPath();
        c.arc(x, y, 3, 0, Math.PI * 2);
        c.fill();
        if (!reduced)
          for (let i = 0; i < 16; i++) {
            const angle = (i / 16) * Math.PI * 2,
              distance = age * (40 + (i % 4) * 15);
            c.globalAlpha = 1 - age;
            c.fillRect(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance, 3, 2);
          }
        c.globalAlpha = 1;
      }
      if (!reduced && time - burstAt < 1_300) {
        const age = (time - burstAt) / 1_300;
        for (let i = 0; i < 22; i++) {
          c.fillStyle = i % 2 ? '#c6f9a7' : '#ffad67';
          c.globalAlpha = 1 - age;
          const angle = (i / 22) * Math.PI * 2,
            distance = age * (90 + i * 4);
          c.fillRect(
            width * 0.52 + Math.cos(angle) * distance,
            height * 0.6 + Math.sin(angle) * distance + age * age * 100,
            3,
            5,
          );
        }
        c.globalAlpha = 1;
      }
    },
  };
}
