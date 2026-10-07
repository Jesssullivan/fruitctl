import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { scene, sceneKernel } from './scene.mjs';

function browserFixture(scene, runId) {
  const canvas = document.querySelector('canvas'), status = document.querySelector('#status');
  const button = document.querySelector('button'), context = canvas.getContext('2d', { alpha: false });
  let started = false, entering = false, startTime, frozen, lastSequence;
  const fullscreen = () => document.fullscreenElement || document.webkitFullscreenElement;
  const dimensions = () => ({ width: Math.round(innerWidth * devicePixelRatio), height: Math.round(innerHeight * devicePixelRatio) });
  function fail(message) { started = false; status.textContent = message; document.body.classList.remove('running'); }
  function enterFullscreen(element) {
    const request = element.requestFullscreen || element.webkitRequestFullscreen;
    if (!request) return Promise.reject(new Error('Fullscreen API unavailable; trial cannot start.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        for (const name of ['fullscreenchange', 'webkitfullscreenchange']) document.removeEventListener(name, changed);
        for (const name of ['fullscreenerror', 'webkitfullscreenerror']) document.removeEventListener(name, failed);
        if (error) reject(error); else resolve();
      };
      const changed = () => { if (fullscreen() === element) finish(); };
      const failed = () => finish(new Error('Fullscreen request failed; trial cannot start.'));
      for (const name of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(name, changed);
      for (const name of ['fullscreenerror', 'webkitfullscreenerror']) document.addEventListener(name, failed);
      const timer = setTimeout(() => finish(new Error('Fullscreen entry timed out; trial cannot start.')), 5000);
      try {
        // WebKit may return void and enter fullscreen later. Promise completion
        // alone never substitutes for the actual requested fullscreen element.
        Promise.resolve(request.call(element)).then(changed, error => finish(error));
      } catch (error) { finish(error); }
    });
  }
  function draw(now) {
    if (!started) return;
    const current = dimensions();
    if (fullscreen() !== document.documentElement || current.width !== frozen.width || current.height !== frozen.height) { fail('Fullscreen or native geometry changed; end this trial.'); return; }
    const sequence = Math.floor((now - startTime) / 250);
    if (sequence !== lastSequence) {
      scene.draw({ ...frozen, runId, sequence }, (x, y, w, h, rgba) => {
        context.fillStyle = `rgb(${rgba[0]},${rgba[1]},${rgba[2]})`; context.fillRect(x, y, w, h);
      });
      lastSequence = sequence;
    }
    requestAnimationFrame(draw);
  }
  button.addEventListener('click', async () => {
    if (started || entering) return;
    entering = true; button.disabled = true;
    try {
      await enterFullscreen(document.documentElement);
      frozen = dimensions(); scene.geometry(frozen.width, frozen.height);
      canvas.width = frozen.width; canvas.height = frozen.height;
      document.body.classList.add('running'); startTime = performance.now(); lastSequence = undefined; started = true;
      requestAnimationFrame(draw);
    } catch (error) { fail(error.message); }
    finally { entering = false; button.disabled = false; }
  });
  status.textContent = `Format ${scene.format}; run ${runId}. Set zoom to 100%, start fullscreen, then park the visible pointer at 50% across / 82% down. Keep it there during frames; use the local Stop menu afterward.`;
}

export function generateHTML(runId) {
  scene.markerBytes({ runId, sequence: 0, width: 960, height: 640, markerId: 0 });
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fruitctl versioned qualification fixture</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#404040;color:white;font:18px system-ui}canvas{display:none;width:100vw;height:100vh}.running canvas{display:block}.running #prepare{display:none}#prepare{max-width:60em;margin:2em}button{font:inherit;padding:1em}</style>
<body><div id="prepare"><p id="status"></p><button type="button">Start full-screen markers</button><p>Seven changing CRC-bound markers. The visible pointer stays included. A fullscreen or geometry change ends this scene; reusing this page does not create a new run identity.</p></div><canvas></canvas>
<script>const scene=(${sceneKernel.toString()})();(${browserFixture.toString()})(scene,${JSON.stringify(runId)});</script></body></html>\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [output, suppliedRunId] = process.argv.slice(2), runId = suppliedRunId ?? randomBytes(16).toString('hex');
  if (!output || process.argv.length > 4) { process.stderr.write('Usage: node test/qualification/generate.mjs OUTPUT.html [RUN_ID]\n'); process.exitCode = 2; }
  else { await writeFile(output, generateHTML(runId), { flag: 'wx', mode: 0o600 }); process.stdout.write(`${JSON.stringify({ format: scene.format, runId, output })}\n`); }
}
