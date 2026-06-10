from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from diffusers import DiffusionPipeline
import torch
import os
import base64
from io import BytesIO
import time
import uuid
from typing import Optional, List, Dict, Any
from PIL import Image
from queue import Queue, Full
import threading
from datetime import datetime, timedelta
from enum import Enum

app = FastAPI(title="Z-Image-Turbo API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

output_dir = "./output"
os.makedirs(output_dir, exist_ok=True)

app.mount("/static", StaticFiles(directory=output_dir), name="static")

MODEL_PATH = os.environ.get("MODEL_PATH", "/home/user/modelscope/Z-Image-Turbo")
TASK_TTL_SECONDS = int(os.environ.get("TASK_TTL_SECONDS", 3600))
QUEUE_MAX_SIZE = int(os.environ.get("QUEUE_MAX_SIZE", 5))

RESOLUTION_PRESETS: Dict[str, int] = {
    "480p": 480,
    "720p": 720,
    "1k": 1024,
    "2k": 2048,
}

ASPECT_RATIOS: Dict[str, tuple] = {
    "1:1": (1, 1),
    "16:9": (16, 9),
    "9:16": (9, 16),
    "4:3": (4, 3),
    "3:4": (3, 4),
    "3:2": (3, 2),
    "2:3": (2, 3),
    "21:9": (21, 9),
    "9:21": (9, 21),
}

class ResponseFormat(str, Enum):
    url = "url"
    b64_json = "b64_json"

class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., description="图像生成提示词")
    size: Optional[str] = Field(
        default="1k",
        description='分辨率预设(480p/720p/1k/2k)或自定义尺寸(如"1024x768")'
    )
    aspect_ratio: Optional[str] = Field(
        default="1:1",
        description='宽高比(1:1/16:9/9:16/4:3/3:4/3:2/2:3/21:9/9:21)'
    )
    n: int = Field(default=1, ge=1, le=4, description="生成图片数量(1-4)")
    seed: Optional[int] = Field(default=None, description="随机种子")
    response_format: ResponseFormat = Field(
        default=ResponseFormat.url,
        description="返回格式: url 或 b64_json"
    )
    num_inference_steps: Optional[int] = Field(
        default=9, ge=1, le=50, description="推理步数(1-50)，Turbo模型推荐9(实际8步DiT前向)"
    )

devices = []

if torch.cuda.is_available():
    gpu_count = torch.cuda.device_count()
    for i in range(gpu_count):
        devices.append(f"cuda:{i}")
else:
    devices.append("cpu")

print("Available devices:", devices)

pipes = {}

for d in devices:
    print(f"Loading Z-Image-Turbo model on {d} ...")
    pipe = DiffusionPipeline.from_pretrained(
        MODEL_PATH,
        torch_dtype=torch.bfloat16 if "cuda" in d else torch.float32,
        low_cpu_mem_usage=False,
    ).to(d)
    pipes[d] = pipe

print("All Z-Image-Turbo models loaded")

task_queue = Queue(maxsize=QUEUE_MAX_SIZE)
tasks: Dict[str, Dict[str, Any]] = {}
tasks_lock = threading.Lock()

def set_task(task_id: str, **kwargs):
    with tasks_lock:
        tasks[task_id].update(kwargs)

def get_task(task_id: str) -> Optional[Dict]:
    with tasks_lock:
        return tasks.get(task_id)

def create_task(task_id: str, **kwargs):
    with tasks_lock:
        tasks[task_id] = kwargs

def cleanup_expired_tasks():
    now = datetime.now()
    with tasks_lock:
        expired = [
            tid for tid, t in tasks.items()
            if t.get("expires_at") and t["expires_at"] < now
        ]
        for tid in expired:
            del tasks[tid]
    if expired:
        print(f"Cleaned up {len(expired)} expired tasks")

def resolve_size(size: Optional[str], aspect_ratio: Optional[str]) -> tuple:
    if not size:
        size = "1k"
    if not aspect_ratio:
        aspect_ratio = "1:1"

    size = size.strip().lower()
    aspect_ratio = aspect_ratio.strip().lower()

    if "x" in size:
        try:
            w, h = size.split("x")
            width, height = int(w), int(h)
        except (ValueError, TypeError):
            width, height = 1024, 1024
    elif size in RESOLUTION_PRESETS:
        short_side = RESOLUTION_PRESETS[size]
        if aspect_ratio in ASPECT_RATIOS:
            rw, rh = ASPECT_RATIOS[aspect_ratio]
            if rw >= rh:
                height = short_side
                width = int(short_side * rw / rh)
            else:
                width = short_side
                height = int(short_side * rh / rw)
        else:
            width, height = short_side, short_side
    else:
        width, height = 1024, 1024

    width = max(512, min(4096, (width // 16) * 16))
    height = max(512, min(4096, (height // 16) * 16))

    return width, height

def worker(device: str):
    pipe = pipes[device]

    while True:
        task = task_queue.get()

        task_id = task["task_id"]
        prompt = task["prompt"]
        n = task["n"]
        width = task["width"]
        height = task["height"]
        seed = task["seed"]
        response_format = task["response_format"]
        num_inference_steps = task["num_inference_steps"]

        print(f"[{device}] processing {task_id} | {width}x{height} | seed={seed} | steps={num_inference_steps}")

        generator = torch.Generator(device=device).manual_seed(seed)

        results = []

        try:
            set_task(task_id, status="processing")

            for i in range(n):
                image = pipe(
                    prompt=prompt,
                    width=width,
                    height=height,
                    num_inference_steps=num_inference_steps,
                    guidance_scale=0.0,
                    generator=generator,
                ).images[0]

                filename = f"{task_id}_{i}.png"
                save_path = os.path.join(output_dir, filename)
                image.save(save_path)

                item: Dict[str, Any] = {
                    "url": f"/static/{filename}",
                }

                if response_format == "b64_json":
                    buffered = BytesIO()
                    image.save(buffered, format="PNG")
                    img_base64 = base64.b64encode(buffered.getvalue()).decode()
                    item["b64_json"] = img_base64

                results.append(item)

            set_task(
                task_id,
                status="finished",
                data=results,
                finished_at=datetime.now().isoformat(),
            )

        except Exception as e:
            print(f"[{device}] task {task_id} failed: {e}")
            set_task(task_id, status="failed", error=str(e))

        task_queue.task_done()

        cleanup_expired_tasks()

for d in devices:
    t = threading.Thread(target=worker, args=(d,), daemon=True)
    t.start()

@app.get("/health")
async def health():
    queue_size = task_queue.qsize()
    return {
        "status": "ok",
        "model": "Z-Image-Turbo",
        "queue_size": queue_size,
        "queue_max": QUEUE_MAX_SIZE,
        "devices": devices,
        "active_tasks": len([
            t for t in tasks.values()
            if t.get("status") in ("queued", "processing")
        ]),
    }

@app.get("/v1/images/info")
async def image_info():
    return {
        "model": "Z-Image-Turbo",
        "resolutions": list(RESOLUTION_PRESETS.keys()),
        "aspect_ratios": list(ASPECT_RATIOS.keys()),
        "response_formats": ["url", "b64_json"],
        "max_images_per_request": 4,
        "custom_size_format": "WxH (e.g. 1024x768)",
        "recommended_params": {
            "resolution": "512x512 ~ 2048x2048",
            "guidance_scale": "0.0 (Turbo模型必须为0)",
            "num_inference_steps": "9 (实际8步DiT前向)",
        },
    }

@app.post("/v1/images/generations")
async def generate_image(req: ImageGenerationRequest):
    width, height = resolve_size(req.size, req.aspect_ratio)

    if req.seed is not None:
        seed = req.seed
    else:
        seed = uuid.uuid4().int & 0xFFFFFFFF

    task_id = "task_" + uuid.uuid4().hex[:10]

    task_payload = {
        "task_id": task_id,
        "prompt": req.prompt,
        "n": req.n,
        "width": width,
        "height": height,
        "seed": seed,
        "response_format": req.response_format.value,
        "num_inference_steps": req.num_inference_steps,
    }

    create_task(
        task_id,
        status="queued",
        data=None,
        prompt=req.prompt,
        size=f"{width}x{height}",
        seed=seed,
        created_at=datetime.now().isoformat(),
        expires_at=datetime.now() + timedelta(seconds=TASK_TTL_SECONDS),
    )

    try:
        task_queue.put_nowait(task_payload)
    except Full:
        with tasks_lock:
            del tasks[task_id]
        raise HTTPException(
            status_code=503,
            detail=f"Task queue is full (max {QUEUE_MAX_SIZE}), please retry later"
        )

    return {
        "task_id": task_id,
        "status": "queued",
        "size": f"{width}x{height}",
        "seed": seed,
    }

@app.get("/v1/tasks/{task_id}")
async def get_task_status(task_id: str):
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    resp: Dict[str, Any] = {
        "task_id": task_id,
        "status": task["status"],
    }

    if task.get("data"):
        resp["data"] = task["data"]
    if task.get("error"):
        resp["error"] = task["error"]
    if task.get("size"):
        resp["size"] = task["size"]
    if task.get("seed"):
        resp["seed"] = task["seed"]
    if task.get("created_at"):
        resp["created_at"] = task["created_at"]
    if task.get("finished_at"):
        resp["finished_at"] = task["finished_at"]

    return resp

@app.delete("/v1/tasks/{task_id}")
async def delete_task(task_id: str):
    with tasks_lock:
        if task_id not in tasks:
            raise HTTPException(status_code=404, detail="Task not found")
        del tasks[task_id]
    return {"message": "Task deleted", "task_id": task_id}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8192)
