import { useEffect, useRef, useState, type CSSProperties } from "react";
import { clock, effect, frame, frameLoop, init, surface, type FrameLoopHandle, type Surface } from "vgpu";
import "./CoreScene.css";

export interface CoreSceneProps {
  level: number;
  active: boolean;
  activity?: "idle" | "listening" | "thinking" | "speaking";
  onRenderer?: (label: string) => void;
}

type RendererState = "pending" | "webgpu" | "fallback";

const HOLOGRAPHIC_SHADER = /* wgsl */ `
struct Params {
  time: f32,
  level: f32,
  engagement: f32,
  thinking: f32,
  speaking: f32,
  pulse: f32,
  resolution: vec2f,
}

@group(0) @binding(0) var<uniform> params: Params;

const TAU: f32 = 6.28318530718;

fn rotate2d(value: vec2f, angle: f32) -> vec2f {
  let sine = sin(angle);
  let cosine = cos(angle);
  return vec2f(cosine * value.x - sine * value.y, sine * value.x + cosine * value.y);
}

fn rotatePoint(point: vec3f, time: f32, layer: f32) -> vec3f {
  // Different incommensurate phases make each shell accelerate and drift independently.
  let drift = sin(time * 0.73 + layer * 2.3) * 0.65 + sin(time * 0.31 + layer * 4.7) * 0.48;
  var result = point;
  let xz = rotate2d(result.xz, time * (0.22 + layer * 0.031) + drift + layer * 0.8);
  result = vec3f(xz.x, result.y, xz.y);
  let yz = rotate2d(result.yz, -time * (0.24 + layer * 0.027) + drift * 0.62 + layer * 0.43);
  result = vec3f(result.x, yz.x, yz.y);
  let xy = rotate2d(result.xy, time * (0.15 + layer * 0.023) - drift * 0.4 - layer * 0.31);
  return vec3f(xy.x, xy.y, result.z);
}

fn sdTorus(point: vec3f, majorRadius: f32, minorRadius: f32) -> f32 {
  let radial = length(point.xz) - majorRadius;
  return length(vec2f(radial, point.y)) - minorRadius;
}

fn sphereHits(origin: vec3f, direction: vec3f, radius: f32) -> vec2f {
  let b = dot(origin, direction);
  let c = dot(origin, origin) - radius * radius;
  let discriminant = b * b - c;
  if (discriminant <= 0.0) {
    return vec2f(-1.0, -1.0);
  }
  let root = sqrt(discriminant);
  return vec2f(-b - root, -b + root);
}

fn hash21(value: vec2f) -> f32 {
  return fract(sin(dot(value, vec2f(127.1, 311.7))) * 43758.5453);
}

fn flowingNoise(value: f32) -> f32 {
  let cell = floor(value);
  let f = fract(value);
  let blend = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(hash21(vec2f(cell, 17.3)), hash21(vec2f(cell + 1.0, 17.3)), blend);
}

fn softLine(value: f32, width: f32) -> f32 {
  return 1.0 - smoothstep(0.0, width, abs(value)) + exp(-abs(value) / (width * 2.5)) * 0.12;
}

fn circuitPattern(point: vec3f, time: f32, layer: f32) -> f32 {
  let normal = normalize(point);
  let rotated = normalize(rotatePoint(normal, time * 0.32, layer));
  let uv = rotated.xy * 0.5 + vec2f(0.5, 0.5);
  let scale = vec2f(18.0 + layer * 2.2, 14.0 + layer * 1.7);
  let scaled = uv * scale + vec2f(time * 0.012 * (layer + 1.0), 0.0);
  let cell = floor(scaled);
  let local = fract(scaled);
  let seed = hash21(cell + vec2f(layer * 7.1, layer * 13.7));
  let seedTwo = hash21(cell + vec2f(19.0 + layer * 3.0, 5.0));
  let seedThree = hash21(cell + vec2f(41.0, 23.0 + layer));
  let energy = 0.4 + params.thinking * 0.4 + params.speaking * 0.3;
  let densityField = flowingNoise(params.pulse * 0.38 + dot(rotated, vec3f(1.7, 2.3, 1.1)) + layer * 7.1);
  let density = clamp(0.28 + densityField * 0.5 + (flowingNoise(params.pulse * 0.65 + seed * 19.0) - 0.5) * energy, 0.1, 0.94);
  let horizontal = softLine(local.y - 0.5, 0.036) * smoothstep(1.0 - density - 0.16, 1.0 - density + 0.04, seed);
  let vertical = softLine(local.x - 0.5, 0.036) * smoothstep(1.1 - density - 0.12, 1.1 - density + 0.1, seedTwo);
  let branchY = 0.18 + seedThree * 0.64;
  let branch = softLine(local.y - branchY, 0.019) * smoothstep(1.27 - density - 0.1, 1.27 - density + 0.1, seedTwo);
  let diagonal = softLine(local.x - local.y, 0.021) * smoothstep(1.4 - density - 0.08, 1.4 - density + 0.08, seed);
  let node = (1.0 - smoothstep(0.0, 0.09, length(local - vec2f(0.5, 0.5)))) * smoothstep(1.2 - density - 0.1, 1.2 - density + 0.1, seedThree);
  let macroLongitude = softLine(fract(uv.x * 9.0) - 0.5, 0.014) * 0.18;
  let macroLatitude = softLine(fract(uv.y * 7.0) - 0.5, 0.014) * 0.15;
  let pulse = 0.86 + 0.14 * sin(time * 1.7 + seed * TAU + layer);
  return clamp((horizontal + vertical + branch + diagonal + node * 1.35 + macroLongitude + macroLatitude) * pulse, 0.0, 1.0);
}

fn orbitalPattern(point: vec3f, radius: f32, time: f32, layer: f32) -> f32 {
  var first = point;
  let firstXZ = rotate2d(first.xz, time * (0.16 + layer * 0.021) + layer * 0.7);
  first = vec3f(firstXZ.x, first.y, firstXZ.y);
  let firstYZ = rotate2d(first.yz, 0.62 + sin(time * 0.19 + layer) * 0.16);
  first = vec3f(first.x, firstYZ.x, firstYZ.y);
  let second = vec3f(first.y, first.z, first.x);
  let third = vec3f(first.z, first.x, first.y);
  let firstDistance = abs(first.y - radius * 0.25);
  let secondDistance = abs(second.y + radius * 0.18);
  let thirdDistance = abs(third.y);
  let angle = atan2(first.z, first.x);
  let breaks = step(0.13, fract(angle * 2.4 + layer * 0.7));
  let ticks = step(0.84, fract(angle * 29.0));
  return (
    exp(-330.0 * firstDistance) * 0.8 * breaks +
    exp(-350.0 * secondDistance) * 0.5 +
    exp(-390.0 * thirdDistance) * 0.45 * breaks +
    exp(-75.0 * firstDistance) * ticks * 0.25
  );
}

fn sparkPattern(point: vec3f, time: f32, layer: f32) -> f32 {
  let q = normalize(rotatePoint(normalize(point), time * 0.05, layer + 5.0));
  let cell = floor((q.xz * 0.5 + vec2f(0.5, 0.5)) * (31.0 + layer * 2.0));
  let local = fract((q.xz * 0.5 + vec2f(0.5, 0.5)) * (31.0 + layer * 2.0));
  let seed = hash21(cell + vec2f(layer * 5.0, 17.0));
  let dotShape = 1.0 - smoothstep(0.0, 0.055, length(local - vec2f(0.5, 0.5)));
  let twinkle = 0.4 + 0.6 * sin(time * (2.2 + seed * 2.4) + seed * TAU);
  return dotShape * step(0.965, seed) * twinkle;
}

fn sphereSurface(
  point: vec3f,
  direction: vec3f,
  radius: f32,
  time: f32,
  level: f32,
  layer: f32,
  backFace: bool,
) -> vec3f {
  let normal = normalize(point);
  let facing = abs(dot(normal, -direction));
  let edge = pow(1.0 - facing, 1.8);
  let circuit = circuitPattern(point, time, layer);
  let orbital = orbitalPattern(point, radius, time, layer);
  let spark = sparkPattern(point, time, layer);
  let opacity = select(1.0, 0.34, backFace);
  let light = normalize(vec3f(-0.42, 0.72, 0.52));
  let diffuse = max(dot(normal, light), 0.0);
  let amber = vec3f(1.0, 0.42, 0.035);
  let gold = vec3f(1.0, 0.78, 0.26);
  let toneAmount = clamp(0.48 + orbital * 0.25 + circuit * 0.27, 0.0, 1.0);
  let tone = amber + (gold - amber) * toneAmount;
  let lines = (circuit * (0.95 + level * 0.4) + orbital * 1.42 + spark * 0.92) * opacity;
  let rim = edge * (0.035 + level * 0.045) * opacity;
  let shaded = 0.62 + diffuse * 0.55;
  return tone * (lines + rim) * shaded + vec3f(1.0, 0.72, 0.21) * spark * 0.55 * opacity;
}

fn shellLayer(
  origin: vec3f,
  direction: vec3f,
  radius: f32,
  time: f32,
  level: f32,
  layer: f32,
) -> vec3f {
  let hits = sphereHits(origin, direction, radius);
  if (hits.x < 0.0) {
    return vec3f(0.0, 0.0, 0.0);
  }
  let frontPoint = origin + direction * hits.x;
  let backPoint = origin + direction * hits.y;
  let front = sphereSurface(frontPoint, direction, radius, time, level, layer, false);
  let back = sphereSurface(backPoint, direction, radius, time, level, layer, true);
  return front + back;
}

fn hotCore(origin: vec3f, direction: vec3f, time: f32, level: f32, activity: f32) -> vec3f {
  let radius = 0.125 + level * 0.012 + sin(time * 2.1) * 0.005 * (0.35 + activity * 0.65);
  let hits = sphereHits(origin, direction, radius);
  if (hits.x < 0.0) {
    return vec3f(0.0, 0.0, 0.0);
  }
  let point = origin + direction * hits.x;
  let normal = normalize(point);
  let facing = max(dot(normal, -direction), 0.0);
  let ring = orbitalPattern(point, radius, time * 1.35, 8.0);
  let circuit = circuitPattern(point, time * 1.2, 8.0);
  let light = max(dot(normal, normalize(vec3f(-0.32, 0.75, 0.5))), 0.0);
  let pulse = 1.0 + 0.18 * sin(time * 2.4) * (0.4 + activity * 0.6);
  let whiteHot = vec3f(1.0, 0.96, 0.72) * (0.55 + facing * 0.45) * pulse;
  let goldHot = vec3f(1.0, 0.47, 0.055) * (0.42 + light * 0.6 + ring * 0.78 + circuit * 0.31);
  let coreLatitude = softLine(fract(normal.y * 5.0 + time * 0.08) - 0.5, 0.12);
  let coreLongitude = softLine(fract(atan2(normal.z, normal.x) * 2.0) - 0.5, 0.10);
  return (whiteHot * 0.45 + goldHot * 0.45) * (coreLatitude + coreLongitude + ring * 0.45 + 0.04);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let safeResolution = max(params.resolution, vec2f(1.0));
  var screen = uv * 2.0 - 1.0;
  screen.x *= safeResolution.x / safeResolution.y;

  let time = params.time;
  let thinking = params.thinking;
  let speaking = params.speaking;
  let level = clamp(params.level, 0.0, 1.0);
  let activity = clamp(params.engagement, 0.0, 1.0);
  let radius = length(screen);
  let vignette = 1.0 - smoothstep(0.36, 1.56, radius);
  let scanline = 0.5 + 0.5 * sin(screen.y * safeResolution.y * 0.033 + time * 1.3);
  let horizon = exp(-20.0 * abs(screen.y + 0.35)) * 0.024;
  let ambient = vec3f(0.031, 0.043, 0.063) + vec3f(0.015, 0.012, 0.008) * vignette;
  var color = ambient + vec3f(0.022, 0.012, 0.004) * scanline * vignette + vec3f(0.16, 0.048, 0.006) * horizon;

  let origin = vec3f(0.0, 0.0, 3.55);
  let breath = 0.86 + thinking * (0.05 + sin(params.pulse * 3.0) * 0.025) + speaking * (0.07 + level * 0.18);
  let stretch = vec2f(1.0 + sin(params.pulse * 4.2) * speaking * level * 0.025, 1.0);
  let direction = normalize(vec3f(screen * 0.55 / (breath * stretch), -1.75));
  var core = vec3f(0.0, 0.0, 0.0);
  core += shellLayer(origin, direction, 0.48, time * 1.18, level, 0.0) * 0.72;
  core += shellLayer(origin, direction, 0.61 + thinking * 0.025, time * 0.92, level, 1.0) * 0.84;
  core += shellLayer(origin, direction, 0.74 + thinking * 0.018, time * 0.73, level, 2.0) * 0.96;
  core += shellLayer(origin, direction, 0.86, time * 0.58, level, 3.0) * 1.03;
  core += shellLayer(origin, direction, 0.96, time * 0.42, level, 4.0) * 0.74;
  let sweep = pow(0.5 + 0.5 * cos(atan2(screen.y, screen.x) - params.pulse * 2.7), 14.0) * thinking;
  color += core * (1.28 + speaking * (0.22 + level * 0.55) + sweep * 0.7);
  color += hotCore(origin, direction, time, level, activity) * (0.93 + activity * 0.42);

  let innerHalo = exp(-12.0 * abs(radius - (0.36 + level * 0.024))) * (0.12 + activity * 0.14);
  let outerHalo = exp(-15.0 * abs(radius - 0.88)) * (0.045 + activity * 0.075);
  let coreBloom = exp(-20.0 * radius * radius) * (0.16 + activity * 0.12) + exp(-180.0 * radius * radius) * 0.35;
  color += vec3f(1.0, 0.27, 0.018) * innerHalo;
  color += vec3f(1.0, 0.48, 0.05) * outerHalo;
  color += vec3f(1.0, 0.74, 0.22) * coreBloom;

  let grid = smoothstep(0.965, 1.0, abs(sin(screen.x * 20.0)) * abs(sin(screen.y * 16.0)));
  color += vec3f(0.08, 0.028, 0.004) * grid * vignette * (0.25 + level * 0.32);

  let speckCell = floor((screen + 2.0) * 29.0);
  let speck = step(0.994, hash21(speckCell));
  let speckDistance = smoothstep(1.2, 0.18, radius);
  color += vec3f(1.0, 0.33, 0.035) * speck * speckDistance * (0.13 + level * 0.16);

  color *= vignette * 0.94 + 0.06;
  color = pow(max(color, vec3f(0.0)), vec3f(0.82));
  return vec4f(color, 1.0);
}
`;

function motionNoise(time: number) {
  const cell = Math.floor(time);
  const f = time - cell;
  const blend = f * f * f * (f * (f * 6 - 15) + 10);
  const hash = (n: number) => { const v = Math.sin(n * 127.1 + 31.7) * 43758.5453; return v - Math.floor(v); };
  return hash(cell) * (1 - blend) + hash(cell + 1) * blend;
}

const clampLevel = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

function isWebGpuAvailable(): boolean {
  if (typeof navigator === "undefined") return false;
  return Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

function prefersReducedMotion(): MediaQueryList | undefined {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
  return window.matchMedia("(prefers-reduced-motion: reduce)");
}

export function CoreScene({ level, active, activity = "idle", onRenderer }: CoreSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(clampLevel(level));
  const activeRef = useRef(active);
  const activityRef = useRef(activity);
  const rendererCallbackRef = useRef(onRenderer);
  const reducedMotionRef = useRef(false);
  const [renderer, setRenderer] = useState<RendererState>("pending");

  levelRef.current = clampLevel(level);
  activeRef.current = active;
  activityRef.current = activity;
  rendererCallbackRef.current = onRenderer;

  useEffect(() => {
    let disposed = false;
    let gpu: Awaited<ReturnType<typeof init>> | undefined;
    let canvasSurface: Surface | undefined;
    let loop: FrameLoopHandle | undefined;
    let removeGpuErrorListener: (() => void) | undefined;
    let removeResizeListener: (() => void) | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const motionQuery = prefersReducedMotion();
    reducedMotionRef.current = motionQuery?.matches ?? false;

    const reportRenderer = (next: RendererState, label: string) => {
      if (disposed) return;
      setRenderer(next);
      rendererCallbackRef.current?.(label);
    };

    let previousTime = 0;
    let orbitTime = 0;
    let envelope = 0;
    let thinking = 0;
    let speaking = 0;
    const updateEffect = (time: number) => {
      const dt = Math.max(0, Math.min(0.05, time - previousTime));
      previousTime = time;
      const blend = 1 - Math.exp(-dt * 7);
      thinking += ((activityRef.current === 'thinking' ? 1 : 0) - thinking) * blend;
      speaking += ((activityRef.current === 'speaking' ? 1 : 0) - speaking) * blend;
      const targetLevel = activityRef.current === 'speaking' ? levelRef.current : 0;
      envelope += (targetLevel - envelope) * (1 - Math.exp(-dt * (targetLevel > envelope ? 16 : 5)));
      const surge = motionNoise(time * 0.7);
      const irregularSpeed = 0.35 + surge * surge * 3.5;
      orbitTime += dt * (0.65 + thinking * 3.3 + speaking * (1.2 + envelope * 2.0)) * irregularSpeed;
      if (disposed || !gpu || !canvasSurface) return;
      const width = canvasSurface.size[0];
      const height = canvasSurface.size[1];
      const effectInstance = activeEffect;
      if (!effectInstance) return;
      effectInstance.set({
        params: {
          time: orbitTime,
          pulse: time,
          thinking,
          speaking,
          level: envelope,
          engagement: activeRef.current ? 1 : 0,
          resolution: [width, height],
        },
      });
    };

    const renderFrame = (time: number) => {
      updateEffect(time);
      if (gpu && canvasSurface && activeEffect) frame(gpu, currentFrame => currentFrame.pass(canvasSurface!, activeEffect!));
    };

    let activeEffect: ReturnType<typeof effect> | undefined;

    const startAnimation = () => {
      if (disposed || !gpu || !canvasSurface || !activeEffect) return;
      if (reducedMotionRef.current) {
        loop?.stop();
        loop = undefined;
        renderFrame(0);
        return;
      }
      if (loop) return;
      const gpuClock = clock(gpu);
      loop = frameLoop(gpu, currentFrame => {
        updateEffect(gpuClock.time);
        if (canvasSurface && activeEffect) currentFrame.pass(canvasSurface, activeEffect);
      });
    };

    const handleMotionChange = (event: MediaQueryListEvent) => {
      reducedMotionRef.current = event.matches;
      if (event.matches) {
        loop?.stop();
        loop = undefined;
        renderFrame(0);
      } else {
        startAnimation();
      }
    };

    const boot = async () => {
      if (!isWebGpuAvailable()) {
        reportRenderer("fallback", "CSS fallback");
        return;
      }

      try {
        const canvas = canvasRef.current;
        if (!canvas) return;

        gpu = await init();
        if (disposed) {
          gpu.dispose();
          return;
        }

        const shaderInfo = await gpu.gpu.createShaderModule({code: HOLOGRAPHIC_SHADER}).getCompilationInfo();
        const shaderErrors = shaderInfo.messages.filter(message => message.type === 'error');
        if (shaderErrors.length) throw new Error(shaderErrors.map(message => `${message.lineNum}: ${message.message}`).join('\n'));
        if (disposed) { gpu.dispose(); return; }

        removeGpuErrorListener = gpu.onError((error) => {
          console.warn('JARVIS renderer:', error, (error.cause as {message?: string})?.message);
          if (disposed) return;
          loop?.stop();
          loop = undefined;
          reportRenderer("fallback", "CSS fallback");
        });

        canvasSurface = surface(gpu, canvas, {
          clearColor: [0.031, 0.043, 0.063, 1],
          dpr: [1, 1.5],
          label: "jarvis-holographic-core",
        });
        activeEffect = effect(gpu, HOLOGRAPHIC_SHADER, {
          label: "jarvis-holographic-core-effect",
          set: {
            params: {
              time: 0,
              pulse: 0,
              thinking: 0,
              speaking: 0,
              level: levelRef.current,
              engagement: activeRef.current ? 1 : 0,
              resolution: canvasSurface.size,
            },
          },
        });

        removeResizeListener = canvasSurface.onResize(({ width, height }) => {
          activeEffect?.set({ params: { resolution: [width, height] } });
        });

        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => {
            if (disposed || !canvasSurface || canvasSurface.disposed) return;
            const dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
            canvasSurface.resize([
              Math.max(1, Math.round(canvas.clientWidth * dpr)),
              Math.max(1, Math.round(canvas.clientHeight * dpr)),
            ]);
            if (reducedMotionRef.current) renderFrame(0);
          });
          resizeObserver.observe(canvas);
        }

        reportRenderer("webgpu", "WebGPU / vgpu");
        startAnimation();
      } catch (error) {
        console.warn('JARVIS renderer initialization:', error);
        if (gpu && !gpu.disposed) gpu.dispose();
        gpu = undefined;
        canvasSurface = undefined;
        activeEffect = undefined;
        reportRenderer("fallback", "CSS fallback");
      }
    };

    motionQuery?.addEventListener?.("change", handleMotionChange);
    void boot();

    return () => {
      disposed = true;
      loop?.stop();
      resizeObserver?.disconnect();
      removeGpuErrorListener?.();
      removeResizeListener?.();
      motionQuery?.removeEventListener?.("change", handleMotionChange);
      canvasSurface?.dispose();
      gpu?.dispose();
      gpu = undefined;
      canvasSurface = undefined;
      activeEffect = undefined;
    };
  }, []);

  const visualStyle = {
    "--core-level": String(clampLevel(level)),
    "--core-active": active ? "1" : "0.35",
  } as CSSProperties;

  return (
    <section className="jarvis-core" data-renderer={renderer} data-activity={activity} style={visualStyle} aria-label="JARVIS holographic core">
      <canvas
        ref={canvasRef}
        className="jarvis-core__canvas"
        aria-hidden={renderer !== "webgpu"}
      />
      <div className="jarvis-core__fallback" aria-hidden={renderer === "webgpu"}>
        <div className="jarvis-core__fallback-grid" />
        <div className="jarvis-core__fallback-halo" />
        <div className="jarvis-core__fallback-ring jarvis-core__fallback-ring--outer" />
        <div className="jarvis-core__fallback-ring jarvis-core__fallback-ring--inner" />
        <div className="jarvis-core__fallback-sphere">
          <span />
        </div>
        <div className="jarvis-core__fallback-scan" />
      </div>
      <span className="jarvis-core__status" aria-hidden="true">
        {renderer === "webgpu" ? "GPU CORE" : renderer === "fallback" ? "STANDBY" : "INITIALIZING"}
      </span>
    </section>
  );
}
