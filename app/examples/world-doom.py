#!/usr/bin/env python3
"""A world model generating every frame on your own machine: python examples/world-doom.py

There is no renderer here. A diffusion model is handed the last four frames, the
last four actions and a top-down conditioning map, and it paints what the next
frame looks like. Walk into a corridor and the corridor is imagined, wall by wall.

    pip install onnxruntime numpy 'websockets>=13'
    python examples/world-doom.py --weights ~/.cache/alakazam-studio/doom-engine-arena/deathmatch

Then in the studio: Settings -> World model -> WebSocket endpoint ->
ws://localhost:8765 -> Test connection -> Save -> play any world, and drive with
WASD and the arrow keys.

ON APPLE SILICON IT USES THE GPU/ANE BY DEFAULT and generated 10.1 frames per
second end to end — through the denoiser, the encode and the socket — at the
default 3 denoising steps. The same bridge with --device cpu, alone, on the same
machine, in the same minute: 0.07 fps. That gap is not 6.6x because it is not
only about arithmetic; see `build_session` for what is actually being measured
and why the CPU number depends on what else you have open.

Elsewhere, or with --device cpu, it runs on the CPU. Whether that is a slideshow
you can steer or unusable depends on how busy the machine is.

    --port      default 8765; 0 asks the OS for a free one
    --weights   directory holding denoiser.onnx and init_state.json
    --steps     denoising steps per frame (default 3; 1 is ~3x faster, rougher)
    --device    auto (Apple GPU where available) | metal | cpu
    --cache     where CoreML keeps its compiled graph
    --threads   ONNX intra-op threads on the CPU path (default 8)

WEIGHTS ARE NOT IN THIS REPOSITORY and are not downloaded for you. Point --weights
at a directory you populated yourself. At the time of writing the model this
bridge was built against carries NO LICENCE, so this file deliberately does not
tell you where to get it: until a licence is published, "run it" is not something
this repository can ask of you. The bridge is ours, Apache-2.0, and it ships no
model.

WHAT IT IS. The denoiser was trained on Doom deathmatch play at 64x64. It takes a
discrete action per frame, and it takes no prose at all — so this bridge declares
promptableEvents FALSE and the studio warns that authored beats cannot reach the
picture. That warning is correct. Driving works; storytelling does not.

THE CONDITIONING MAP IS NOT OPTIONAL. `minimap` is a required graph input: six
64x64 channels derived from a dead-reckoned player position in a wall grid. The
model only paints pixels, so something outside it has to remember where the
player is standing, and that is the arena simulation below. The published weights
ship no map, so this file GENERATES one. It is a plain room rather than a
Doom level, which is off the training distribution: expect a corridor-ish
hallucination that responds to movement rather than a faithful level.

ZERO DEPENDENCIES beyond the three the inference itself needs, and one file, so
you can read the whole contract end to end — same reason examples/world-echo.mjs
writes out its own WebSocket framing.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import sys
import time

import numpy as np

# ── The model contract ───────────────────────────────────────────────────────
#
# Read off a working player rather than inferred from tensor shapes. The graph
# declares, and requires, all six of these:
#
#   noisy_next_obs  float32 [1, 3, 64, 64]     the frame being denoised
#   sigma           float32 [1]                current noise level
#   sigma_cond      float32 [1]                noise level of the CONDITIONING
#   obs             float32 [1, 12, 64, 64]    last 4 frames, frame-major
#   act             int64   [1, 4]             last 4 actions
#   minimap         float32 [1, 6, 64, 64]     top-down + first-person conditioning
#   -> denoised     float32 [1, 3, 64, 64]     in [-1, 1]

C, H, W, T = 3, 64, 64, 4
FRAME = C * H * W

SIGMA_MIN = 2e-3
SIGMA_MAX = 5.0
RHO = 7

# sigma_cond is fed SIGMA_MIN rather than 0: the model takes log(sigma_cond)
# internally, and log(0) is -inf.
SIGMA_COND = SIGMA_MIN

# Actions, in the order the model was trained with.
NOOP, FORWARD, TURN_LEFT, TURN_RIGHT, STRAFE_LEFT, STRAFE_RIGHT, ATTACK = range(7)

# The studio's control tokens (src/play/keys.ts) onto those actions.
#
# W/A/D and space follow the original player's own keymap, so a/d TURN and the
# arrow keys — which that player had no binding for — get the strafes. `Back`,
# `look_up` and `look_down` are DROPPED rather than approximated: the model has
# no reverse and no camera pitch, and inventing one would move the player
# somewhere they did not ask to go.
COMMANDS = {
    "Front": FORWARD,
    "Left": TURN_LEFT,
    "Right": TURN_RIGHT,
    "look_left": STRAFE_LEFT,
    "look_right": STRAFE_RIGHT,
    "Up": ATTACK,
}

# The studio sends one command per KEYDOWN and never a keyup: a held key arrives
# as the browser's auto-repeat stream, and its release is either the `idle` token
# or silence. Silence is what has to be turned into a release.
#
# NOT A WALL CLOCK. The first version of this held an action for 700ms and was
# measured, against a no-input control, applying NOTHING: a frame here takes
# 600-1000ms on CPU, so the latch expired before the next frame was ever
# generated and 24 held commands produced a run byte-identical to sitting still.
# A release window has to be counted in FRAMES, because the frame is the only
# clock the model has. One frame with no command arriving is a release, which is
# correct at any rate and needs no tuning.

# ── The arena ────────────────────────────────────────────────────────────────
#
# World coordinates run [0, ARENA] on both axes; the wall grid is 128x128 and
# y is flipped when it is indexed:  col = x*128/ARENA,  row = (ARENA-y)*128/ARENA.
# The deathmatch model was trained with a 2016-unit arena; the health-gathering
# sibling used 1856, and getting it wrong silently mis-scales every channel.

ARENA = 2016.0
MAP = 128
FOV = 90.0
RAYS = 64
MAX_DEPTH = 3000.0
MOVE_SPEED = 16.0
TURN_SPEED = 11.25
MAX_ITEM_DEPTH = 1500.0


def make_arena() -> np.ndarray:
    """A wall grid: +1 wall, -1 open. Seven cells of border, four pillars.

    The border thickness is not decoration — it is the shape the model saw in
    training, where every level was a walled arena with the outer rows and
    columns solid.
    """
    grid = np.full((MAP, MAP), -1.0, dtype=np.float32)
    grid[:7, :] = 1.0
    grid[-7:, :] = 1.0
    grid[:, :7] = 1.0
    grid[:, -7:] = 1.0
    for r0 in (34, 82):
        for c0 in (34, 82):
            grid[r0:r0 + 12, c0:c0 + 12] = 1.0
    return grid


class Arena:
    """Dead reckoning, raycasting, and the six conditioning channels.

    The model generates pixels and nothing else, so the player's position lives
    here. Every number below (move speed, turn rate, ray count, the log-scale
    disparity, the 3x3 marker with its five-pixel heading arrow) is the training
    parameterisation, not a choice made here.
    """

    def __init__(self, grid: np.ndarray, x: float, y: float, yaw: float) -> None:
        self.walls = grid > 0.9
        self.x, self.y, self.yaw = x, y, yaw
        self.scale = MAP / ARENA
        # 128 -> 64 by nearest source cell, exactly as the player does it.
        idx = (np.arange(H) * (MAP / H)).astype(np.int32)
        self.walls_down = np.where(grid[np.ix_(idx, idx)] > 0.9, 1.0, -1.0).astype(np.float32)

    # -- geometry -------------------------------------------------------------

    def _cell(self, wx: float, wy: float) -> tuple[int, int]:
        return int(wx * self.scale), int((ARENA - wy) * self.scale)

    def _is_wall(self, col: int, row: int) -> bool:
        # Out of bounds is PASSABLE, matching the player: the arena border is a
        # wall in the grid, so nothing escapes, and a portal punched in it works.
        if col < 0 or col >= MAP or row < 0 or row >= MAP:
            return False
        return bool(self.walls[row, col])

    def _collides(self, wx: float, wy: float) -> bool:
        col, row = self._cell(wx, wy)
        return self._is_wall(col, row)

    def apply(self, action: int) -> None:
        """Advance the player. Collision tries the full move, then each axis."""
        if action in (FORWARD, STRAFE_LEFT, STRAFE_RIGHT):
            heading = self.yaw + (90 if action == STRAFE_LEFT else -90 if action == STRAFE_RIGHT else 0)
            rad = math.radians(heading)
            nx = self.x + math.cos(rad) * MOVE_SPEED
            ny = self.y + math.sin(rad) * MOVE_SPEED
            if not self._collides(nx, ny):
                self.x, self.y = nx, ny
            elif not self._collides(nx, self.y):
                self.x = nx
            elif not self._collides(self.x, ny):
                self.y = ny
        elif action == TURN_LEFT:
            self.yaw += TURN_SPEED
        elif action == TURN_RIGHT:
            self.yaw -= TURN_SPEED

    def _cast(self) -> np.ndarray:
        """One depth per ray, as log-scale disparity in [-1, 1]."""
        px = self.x * self.scale
        py = (ARENA - self.y) * self.scale
        half = FOV / 2.0
        out = np.empty(RAYS, dtype=np.float32)
        for r in range(RAYS):
            t = (r + 0.5) / RAYS * 2 - 1
            rad = math.radians(self.yaw - t * half)
            out[r] = self._dda(px, py, math.cos(rad), -math.sin(rad)) / self.scale
        clamped = np.clip(out, 1.0, MAX_DEPTH)
        norm = np.log(clamped + 1.0) / math.log(MAX_DEPTH + 1.0)
        return np.clip(norm * 2.0 - 1.0, -1.0, 1.0).astype(np.float32)

    def _dda(self, px: float, py: float, dx: float, dy: float, max_steps: int = 256) -> float:
        eps = 1e-10
        dx = dx if abs(dx) > eps else eps
        dy = dy if abs(dy) > eps else eps
        map_x, map_y = int(math.floor(px)), int(math.floor(py))
        step_x, step_y = (1 if dx > 0 else -1), (1 if dy > 0 else -1)
        t_max_x = (map_x + 1.0 - px) / dx if dx > 0 else (map_x - px) / dx
        t_max_y = (map_y + 1.0 - py) / dy if dy > 0 else (map_y - py) / dy
        t_delta_x, t_delta_y = abs(1.0 / dx), abs(1.0 / dy)
        for _ in range(max_steps):
            if self._is_wall(map_x, map_y):
                t = min(t_max_x, t_max_y)
                return max(math.hypot(t * dx, t * dy), 0.01)
            if t_max_x < t_max_y:
                t_max_x += t_delta_x
                map_x += step_x
            else:
                t_max_y += t_delta_y
                map_y += step_y
            if map_x < 0 or map_x >= MAP or map_y < 0 or map_y >= MAP:
                break
        return MAX_DEPTH * self.scale

    # -- the six channels -----------------------------------------------------

    def _marker(self, plane: np.ndarray, value: float) -> None:
        """A 3x3 block at the player plus a five-pixel arrow along the heading."""
        ci = int(self.x * self.scale * (W / MAP))
        ri = int((ARENA - self.y) * self.scale * (H / MAP))
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                r, c = ri + dr, ci + dc
                if 0 <= r < H and 0 <= c < W:
                    plane[r, c] = value
        rad = math.radians(self.yaw)
        for step in range(1, 6):
            ac = int(ci + math.cos(rad) * step)
            ar = int(ri - math.sin(rad) * step)
            if 0 <= ar < H and 0 <= ac < W:
                plane[ar, ac] = value

    def minimap(self) -> np.ndarray:
        """[6, 64, 64] float32.

        0 disparity, repeated down every row     3 items in FOV
        1 walls + self marker                    4 enemies top-down + self
        2 items top-down + self marker           5 enemies in FOV

        There are no items and no second player in this arena, so channels 2, 3
        and 5 carry what the player sees when everything has been collected and
        the opponent is out of sight — an in-distribution state, not a blank.
        """
        out = np.zeros((6, H, W), dtype=np.float32)
        out[0] = np.tile(self._cast(), (H, 1))
        out[1] = self.walls_down
        self._marker(out[1], 1.0)
        self._marker(out[2], 1.0)
        out[4].fill(-1.0)
        self._marker(out[4], 1.0)
        return out


# ── The sampler ──────────────────────────────────────────────────────────────


def sigma_schedule(num_steps: int) -> np.ndarray:
    """Karras rho-schedule, sigma_max down to sigma_min, then 0."""
    if num_steps == 1:
        return np.array([SIGMA_MAX, 0.0], dtype=np.float32)
    min_inv = SIGMA_MIN ** (1 / RHO)
    max_inv = SIGMA_MAX ** (1 / RHO)
    l = np.arange(num_steps, dtype=np.float64) / (num_steps - 1)
    sigmas = (max_inv + l * (min_inv - max_inv)) ** RHO
    return np.concatenate([sigmas, [0.0]]).astype(np.float32)


def default_cache() -> str:
    """Where CoreML's compiled graph lives. Beside the weights cache, not in the
    repository: it is a build artefact of YOUR machine's CoreML version, and it
    is regenerated whenever that or the model changes."""
    return os.path.expanduser("~/.cache/alakazam-studio/coreml")


def build_session(path: str, device: str, threads: int, cache: str):
    """The ONNX session, on the Apple GPU/ANE where there is one.

    THE FORMAT IS THE WHOLE SPEEDUP, and it is not the obvious knob. Measured on
    an M-series laptop, p50 per denoise step over 60 runs after warmup:

        CPU  (8 threads)                    156 ms      1.0x
        CoreML, compute units CPUAndGPU    7635 ms     0.02x   <- 50x SLOWER
        CoreML, default NeuralNetwork       140 ms      1.1x
        CoreML, compute units CPUAndNE      108 ms      1.4x
        CoreML, MLProgram + units ALL        23.6 ms    6.6x

    `ModelFormat: MLProgram` is the whole difference, and the GPU-only path is
    not merely worse but unusable — which is why this exposes no "use the GPU"
    flag. There is one configuration worth running and picking it is the
    bridge's job, not yours.

    THE 6.6x IS THE FLATTERING NUMBER, because it is measured back to back on an
    idle machine. End to end, alone, on a laptop that was also running a browser
    and a music player (load average ~50 — i.e. a normal working machine):

        Metal   10.1 fps
        CPU      0.07 fps        one frame every fifteen seconds

    The CPU path competes for the same cores as everything else you have open
    and loses; the ANE does not. So the honest claim is not "6.6x faster" but
    "the difference between playable and not, on a machine you are also using".
    Both numbers are here because which one applies depends on your machine, and
    quoting only one of them would be picking the answer.

    The compiled model is CACHED. The first boot spends ~9s letting CoreML
    compile the graph; later boots reuse it and take ~1s. A cache that silently
    missed would look like a slow model, so the path is printed.

    Numerically CoreML runs fp16: the denoised frame differs from the CPU result
    by at most 0.008 on a [-1, 1] output, under 1% of the range this model
    actually uses. Visually identical, and it is the same model either way —
    but it is NOT bit-exact, so a seed does not reproduce across devices.

    FALLBACK IS ANNOUNCED, NEVER SILENT. If CoreML cannot build the session this
    says so and continues on CPU, because a bridge that quietly ran 6.6x slower
    than it promised is the worst of both.
    """
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    available = ort.get_available_providers()
    want_metal = device == "metal" or (device == "auto" and "CoreMLExecutionProvider" in available)

    if want_metal:
        if "CoreMLExecutionProvider" not in available:
            # Asked for explicitly and not there: say which, and do not pretend.
            print(f"[doom] no CoreMLExecutionProvider in this onnxruntime "
                  f"(has {', '.join(available)}); running on CPU", flush=True)
        else:
            os.makedirs(cache, exist_ok=True)
            try:
                sess = ort.InferenceSession(path, opts, providers=[
                    ("CoreMLExecutionProvider", {
                        "MLComputeUnits": "ALL",
                        "ModelFormat": "MLProgram",
                        "ModelCacheDirectory": cache,
                    }),
                    "CPUExecutionProvider",
                ])
                print(f"[doom] Metal via CoreML (MLProgram), compiled-model cache {cache}", flush=True)
                return sess
            except Exception as exc:  # noqa: BLE001 — any failure here means CPU
                print(f"[doom] CoreML session failed ({type(exc).__name__}: {exc}); "
                      f"falling back to CPU", flush=True)

    print(f"[doom] CPU, {threads} threads", flush=True)
    return ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])


class Model:
    def __init__(self, weights: str, num_steps: int, threads: int,
                 device: str = "auto", cache: str = "") -> None:
        path = os.path.join(weights, "denoiser.onnx")
        init = os.path.join(weights, "init_state.json")
        for f in (path, init):
            if not os.path.isfile(f):
                sys.exit(
                    f"missing {f}\n"
                    "  --weights must point at a directory holding denoiser.onnx and\n"
                    "  init_state.json. This repository ships neither."
                )
        self.session = build_session(path, device, threads, cache or default_cache())
        with open(init) as fh:
            state = json.load(fh)
        # The seed rollout: four real frames and the four actions that produced
        # them, so the first generated frame continues something rather than
        # starting from noise.
        self.init_obs = np.asarray(state["obs_buffer"], dtype=np.float32).reshape(T * C, H, W)
        self.init_act = np.asarray(state["act_buffer"], dtype=np.int64)
        self.sigmas = sigma_schedule(num_steps)

        # WARM IT UP BEFORE ANYONE CONNECTS. CoreML defers the real device
        # compile to the first inference, so the first frame of the first
        # session cost several seconds while every later one cost ~24ms. That is
        # not a slow model, it is a cost charged to whoever plays first —
        # `scripts/protocol-check.mjs` failed the `frames` claim on exactly this
        # and passed on reconnect, which is the shape of the bug in one run.
        # Paying it here, once, at a moment that is already a wait.
        t0 = time.time()
        self.session.run(None, {
            "noisy_next_obs": np.zeros((1, C, H, W), dtype=np.float32),
            "sigma": np.array([float(self.sigmas[0])], dtype=np.float32),
            "sigma_cond": np.array([SIGMA_COND], dtype=np.float32),
            "obs": self.init_obs[None],
            "act": self.init_act[None],
            "minimap": np.zeros((1, 6, H, W), dtype=np.float32),
        })
        print(f"[doom] warm in {time.time() - t0:.1f}s · {num_steps} denoise steps/frame", flush=True)

    def step(self, rng: np.random.Generator, obs: np.ndarray, act: np.ndarray, minimap: np.ndarray) -> np.ndarray:
        """One frame. Euler, first order, exactly as the shipped player does it.

        The generator is passed IN, one per session seeded the same way, so that
        two sessions driven differently differ only by the driving. A world model
        wanders on its own noise; without that control "the picture changed"
        measures nothing.
        """
        last = obs[(T - 1) * C: T * C]
        x = last + rng.standard_normal(last.shape).astype(np.float32) * self.sigmas[0]
        for i in range(len(self.sigmas) - 1):
            sigma, nxt = float(self.sigmas[i]), float(self.sigmas[i + 1])
            den = self.session.run(
                None,
                {
                    "noisy_next_obs": x[None],
                    "sigma": np.array([sigma], dtype=np.float32),
                    "sigma_cond": np.array([SIGMA_COND], dtype=np.float32),
                    "obs": obs[None],
                    "act": act[None],
                    "minimap": minimap[None],
                },
            )[0][0]
            x = x + ((x - den) / sigma) * (nxt - sigma)
        return x


def to_rgba(frame: np.ndarray) -> bytes:
    """[3,64,64] in [-1,1] -> RGBA bytes, the studio's raw-pixel path."""
    rgb = np.clip((frame + 1.0) * 127.5, 0, 255).astype(np.uint8)
    rgba = np.empty((H, W, 4), dtype=np.uint8)
    rgba[..., 0] = rgb[0]
    rgba[..., 1] = rgb[1]
    rgba[..., 2] = rgb[2]
    rgba[..., 3] = 255
    return rgba.tobytes()


# ── The studio side ──────────────────────────────────────────────────────────


def capabilities(fps: float | None) -> dict:
    """Answer honestly, including the part that disappoints.

    promptableEvents is FALSE because the model's only input is a discrete
    action. Claiming otherwise would give a world where every transition fires,
    the HUD keeps up, and the picture ignores all of it.
    """
    rate = f"About {fps:.1f} generated frames per second here. " if fps else ""
    return {
        "type": "capabilities",
        "streaming": True,
        "promptableEvents": False,
        "heldCommands": True,
        "persistentWorlds": False,
        "note": (
            "A diffusion world model running on this machine's CPU. It takes movement only, "
            "so authored prompt and state beats cannot reach the picture. " + rate +
            "The arena is generated by the bridge, not a Doom level."
        ),
    }


async def session(sock, model: Model, args) -> None:
    import websockets

    arena = Arena(make_arena(), ARENA / 2, ARENA / 2, 0.0)
    rng = np.random.default_rng(args.seed)
    obs = model.init_obs.copy()
    act = model.init_act.copy()
    action = NOOP
    commands_since_frame = 0
    running = False
    measured: list[float] = []
    loop = asyncio.get_running_loop()

    async def paint() -> None:
        nonlocal obs, act, action, commands_since_frame
        while True:
            if commands_since_frame == 0:
                action = NOOP
            commands_since_frame = 0
            act[T - 1] = action
            arena.apply(action)
            minimap = arena.minimap()
            t0 = time.monotonic()
            # Inference is hundreds of milliseconds; on the event loop it would
            # stall the socket and the studio would time out its handshake.
            frame = await loop.run_in_executor(None, model.step, rng, obs.copy(), act.copy(), minimap)
            measured.append(time.monotonic() - t0)
            obs = np.concatenate([obs[C:], frame], axis=0)
            act = np.concatenate([act[1:], [action]])
            await sock.send(json.dumps({"type": "frame", "format": "rgba", "width": W, "height": H}))
            await sock.send(to_rgba(frame))

    def painter_died(task: "asyncio.Task[None]") -> None:
        """Say so when the frame loop stops.

        `paint()` runs as a background task, and a task that raises holds its
        exception until it is garbage collected — so a dead frame loop looks
        exactly like a slow model from the outside: the socket stays open, the
        handshake still answers, and no picture ever arrives. That silence cost
        a debugging session against a port that was serving nothing, with the
        conformance checker reporting `frames: nothing arrived` and no reason
        anywhere. A background task nobody watches is a background task that
        fails quietly, so this watches it.
        """
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            import traceback
            print("[doom] the frame loop STOPPED — no further frames will be sent:", flush=True)
            traceback.print_exception(type(exc), exc, exc.__traceback__)

    painter = None
    try:
        async for raw in sock:
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            kind = msg.get("type")
            if kind == "hello":
                fps = (1.0 / (sum(measured) / len(measured))) if measured else None
                await sock.send(json.dumps(capabilities(fps)))
            elif kind == "start":
                # Nothing expensive happens before this: the model is loaded when
                # the process starts, and a capability probe never gets a session.
                if painter is None:
                    print(f"start {msg.get('worldId', '')} — generating", flush=True)
                    running = True
                    painter = asyncio.create_task(paint())
                    painter.add_done_callback(painter_died)
            elif kind == "event":
                if msg.get("kind") != "command":
                    continue
                value = msg.get("value")
                if value == "idle":
                    action = NOOP
                    commands_since_frame = 0
                elif value in COMMANDS:
                    action = COMMANDS[value]
                    commands_since_frame += 1
            elif kind == "bye":
                break
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        if painter is not None:
            painter.cancel()
        if running and measured:
            mean = sum(measured) / len(measured)
            print(f"generated {len(measured)} frames, {mean * 1000:.0f} ms each, {1 / mean:.2f} fps", flush=True)


async def main() -> None:
    ap = argparse.ArgumentParser(prog="world-doom")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--weights", default=os.path.expanduser("~/.cache/alakazam-studio/doom-engine-arena/deathmatch"))
    ap.add_argument("--steps", type=int, default=3)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--device", choices=["auto", "metal", "cpu"], default="auto",
                    help="auto uses the Apple GPU/ANE when onnxruntime offers CoreML "
                         "(6.6x faster, measured), and CPU otherwise")
    ap.add_argument("--cache", default=default_cache(),
                    help="where CoreML keeps the compiled graph (first boot ~9s, later ~1s)")
    ap.add_argument("--seed", type=int, default=0,
                    help="per-session noise seed; equal seeds make two sessions comparable")
    args = ap.parse_args()

    from websockets.asyncio.server import serve

    model = Model(args.weights, args.steps, args.threads, args.device, args.cache)

    async def handler(sock):
        await session(sock, model, args)

    async with serve(handler, "localhost", args.port) as server:
        # PORT 0 asks the OS for a free one. Hardcoding a port is a false
        # negative waiting to happen: another process holding it turns a working
        # bridge into a broken-looking one. Print what we got.
        bound = next(iter(server.sockets)).getsockname()[1]
        print(f"world model on ws://localhost:{bound}", flush=True)
        await asyncio.get_running_loop().create_future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
