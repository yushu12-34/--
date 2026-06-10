# Z-Image API 客户端使用指南

## 一、API 概览

| 接口 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/v1/images/info` | GET | 查询支持的参数 |
| `/v1/images/generations` | POST | 提交图像生成任务 |
| `/v1/tasks/{task_id}` | GET | 查询任务状态 |
| `/v1/tasks/{task_id}` | DELETE | 删除任务记录 |

**基础地址**: `http://192.168.100.100:8191`

---

## 二、请求参数

### POST `/v1/images/generations`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `prompt` | string | ✅ | - | 图像生成提示词 |
| `negative_prompt` | string | ❌ | `""` | 负面提示词，排除不想要的内容 |
| `size` | string | ❌ | `"1k"` | 分辨率预设或自定义尺寸 |
| `aspect_ratio` | string | ❌ | `"1:1"` | 宽高比 |
| `n` | int | ❌ | `1` | 生成图片数量 (1-4) |
| `seed` | int | ❌ | 随机 | 随机种子 |
| `response_format` | string | ❌ | `"url"` | 返回格式: `"url"` 或 `"b64_json"` |
| `num_inference_steps` | int | ❌ | `50` | 推理步数 (1-100)，推荐 28-50 |
| `guidance_scale` | float | ❌ | `4.0` | CFG 引导强度 (0.0-20.0)，推荐 3.0-5.0 |
| `cfg_normalization` | bool | ❌ | `false` | 是否启用 CFG 归一化 |

### 分辨率预设

| 预设值 | 短边像素 |
|--------|----------|
| `480p` | 480px |
| `720p` | 720px |
| `1k` | 1024px |
| `2k` | 2048px |
| 自定义 | 如 `"1280x720"` |

### 宽高比选项

`1:1` `16:9` `9:16` `4:3` `3:4` `3:2` `2:3` `21:9` `9:21`

### 推荐参数范围

- 分辨率：512×512 至 2048×2048
- 引导尺度 (guidance_scale)：3.0 ~ 5.0
- 推理步数 (num_inference_steps)：28 ~ 50

---

## 三、响应格式

### 提交任务成功

```json
{
    "task_id": "task_abc1234567",
    "status": "queued",
    "size": "1824x1024",
    "seed": 1234567890
}
```

### 任务处理中

```json
{
    "task_id": "task_abc1234567",
    "status": "processing",
    "size": "1824x1024",
    "seed": 1234567890,
    "created_at": "2026-05-06T10:00:00"
}
```

### 任务完成 (url 模式)

```json
{
    "task_id": "task_abc1234567",
    "status": "finished",
    "size": "1824x1024",
    "seed": 1234567890,
    "created_at": "2026-05-06T10:00:00",
    "finished_at": "2026-05-06T10:01:30",
    "data": [
        {
            "url": "/static/task_abc1234567_0.png"
        }
    ]
}
```

### 任务完成 (b64_json 模式)

```json
{
    "task_id": "task_abc1234567",
    "status": "finished",
    "data": [
        {
            "url": "/static/task_abc1234567_0.png",
            "b64_json": "iVBORw0KGgo..."
        }
    ]
}
```

### 任务失败

```json
{
    "task_id": "task_abc1234567",
    "status": "failed",
    "error": "错误信息"
}
```

### 队列已满 (HTTP 503)

```json
{
    "detail": "Task queue is full (max 5), please retry later"
}
```

---

## 四、curl 使用示例

### 1. 基础生成 — 默认 1k 正方形

```bash
curl -X POST http://localhost:8191/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"prompt": "一只在月光下奔跑的白猫"}'
```

### 2. 指定分辨率 + 宽高比

```bash
curl -X POST http://localhost:8191/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "一只在月光下奔跑的白猫",
    "size": "1k",
    "aspect_ratio": "16:9"
  }'
```

### 3. 使用负面提示词

```bash
curl -X POST http://localhost:8191/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "一位优雅的女性站在花园中",
    "negative_prompt": "模糊, 变形, 低质量, 水印",
    "size": "1k",
    "aspect_ratio": "3:4"
  }'
```

### 4. 720p 竖屏 (手机壁纸)

```bash
curl -X POST http://localhost:8191/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "赛博朋克城市夜景",
    "size": "720p",
    "aspect_ratio": "9:16"
  }'
```

### 5. 2K 宽屏 + 指定种子

```bash
curl -X POST http://localhost:8191/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "雪山日出全景",
    "size": "2k",
    "aspect_ratio": "21:9",
    "seed": 42
  }'
```

### 6. 自定义尺寸

```bash
curl -X POST http://localhost:8191/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "水彩风格的花卉",
    "size": "1280x720"
  }'
```

### 7. 返回 Base64 编码

```bash
curl -X POST http://localhost:8191/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "水墨山水画",
    "size": "1k",
    "aspect_ratio": "3:4",
    "response_format": "b64_json"
  }'
```

### 8. 生成多张图

```bash
curl -X POST http://localhost:8191/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "可爱的柯基犬",
    "size": "1k",
    "n": 3
  }'
```

### 9. 启用 CFG 归一化

```bash
curl -X POST http://localhost:8191/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "超写实人像摄影",
    "size": "1k",
    "num_inference_steps": 50,
    "guidance_scale": 4.0,
    "cfg_normalization": true
  }'
```

### 10. 查询任务状态

```bash
curl http://localhost:8191/v1/tasks/task_abc1234567
```

### 11. 删除任务

```bash
curl -X DELETE http://localhost:8191/v1/tasks/task_abc1234567
```

### 12. 健康检查

```bash
curl http://localhost:8191/health
```

### 13. 查询支持的参数

```bash
curl http://localhost:8191/v1/images/info
```

### 14. 完整参数示例

```bash
curl -X POST http://localhost:8191/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "两名年轻亚裔女性紧密站在一起，背景为朴素的灰色纹理墙面",
    "negative_prompt": "模糊, 变形",
    "size": "720p",
    "aspect_ratio": "9:16",
    "n": 1,
    "seed": 42,
    "response_format": "url",
    "num_inference_steps": 50,
    "guidance_scale": 4.0,
    "cfg_normalization": false
  }'
```

---

## 五、Python 使用示例

### 安装依赖

```bash
pip install requests
```

### 封装函数

```python
import requests
import time
import base64

BASE_URL = "http://localhost:8191"


def generate_image(
    prompt: str,
    negative_prompt: str = "",
    size: str = "1k",
    aspect_ratio: str = "1:1",
    n: int = 1,
    seed: int = None,
    response_format: str = "url",
    num_inference_steps: int = 50,
    guidance_scale: float = 4.0,
    cfg_normalization: bool = False,
) -> dict:
    """提交图像生成任务并等待结果"""
    payload = {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "size": size,
        "aspect_ratio": aspect_ratio,
        "n": n,
        "response_format": response_format,
        "num_inference_steps": num_inference_steps,
        "guidance_scale": guidance_scale,
        "cfg_normalization": cfg_normalization,
    }
    if seed is not None:
        payload["seed"] = seed

    resp = requests.post(f"{BASE_URL}/v1/images/generations", json=payload)
    if resp.status_code == 503:
        raise RuntimeError("队列已满，请稍后重试")
    resp.raise_for_status()
    result = resp.json()

    task_id = result["task_id"]
    print(f"任务已提交: {task_id}, 尺寸: {result['size']}, 种子: {result['seed']}")

    return wait_for_task(task_id)


def wait_for_task(task_id: str, timeout: int = 300, interval: int = 3) -> dict:
    """轮询等待任务完成"""
    start = time.time()
    while time.time() - start < timeout:
        resp = requests.get(f"{BASE_URL}/v1/tasks/{task_id}")
        resp.raise_for_status()
        data = resp.json()

        if data["status"] == "finished":
            print(f"任务完成: {task_id}")
            return data
        elif data["status"] == "failed":
            raise RuntimeError(f"任务失败: {data.get('error')}")

        print(f"状态: {data['status']}... 等待中")
        time.sleep(interval)

    raise TimeoutError(f"任务超时: {task_id}")


def save_b64_image(b64_str: str, filepath: str):
    """将 Base64 图片保存到文件"""
    img_data = base64.b64decode(b64_str)
    with open(filepath, "wb") as f:
        f.write(img_data)
    print(f"图片已保存: {filepath}")
```

### 调用示例

```python
# 示例1: 基础生成
result = generate_image("一只在月光下奔跑的白猫")
for item in result["data"]:
    print(f"图片URL: {BASE_URL}{item['url']}")

# 示例2: 使用负面提示词
result = generate_image(
    prompt="一位优雅的女性站在花园中",
    negative_prompt="模糊, 变形, 低质量, 水印",
    size="1k",
    aspect_ratio="3:4",
)

# 示例3: 1K 16:9 宽屏
result = generate_image(
    prompt="赛博朋克城市夜景",
    size="1k",
    aspect_ratio="16:9",
)

# 示例4: 720p 竖屏手机壁纸
result = generate_image(
    prompt="梦幻星空下的少女",
    size="720p",
    aspect_ratio="9:16",
)

# 示例5: 2K 超宽屏 + 指定种子
result = generate_image(
    prompt="雪山日出全景",
    size="2k",
    aspect_ratio="21:9",
    seed=42,
)

# 示例6: 自定义尺寸
result = generate_image(
    prompt="水彩风格的花卉",
    size="1280x720",
)

# 示例7: 获取 Base64 并保存到文件
result = generate_image(
    prompt="水墨山水画",
    size="1k",
    aspect_ratio="3:4",
    response_format="b64_json",
)
for i, item in enumerate(result["data"]):
    save_b64_image(item["b64_json"], f"output_{i}.png")

# 示例8: 启用 CFG 归一化
result = generate_image(
    prompt="超写实人像摄影",
    size="1k",
    num_inference_steps=50,
    guidance_scale=4.0,
    cfg_normalization=True,
)

# 示例9: 批量生成
result = generate_image(
    prompt="可爱的柯基犬",
    size="1k",
    n=3,
)

# 示例10: 完整参数 (参考官方示例)
result = generate_image(
    prompt="两名年轻亚裔女性紧密站在一起，背景为朴素的灰色纹理墙面，可能是室内地毯地面。",
    negative_prompt="",
    size="720p",
    aspect_ratio="9:16",
    seed=42,
    num_inference_steps=50,
    guidance_scale=4.0,
    cfg_normalization=False,
)
```

---

## 六、JavaScript (Node.js) 使用示例

### 安装依赖

```bash
npm install node-fetch
```

### 封装函数

```javascript
const fetch = require("node-fetch");
const fs = require("fs");

const BASE_URL = "http://localhost:8191";

async function generateImage(options) {
    const {
        prompt,
        negative_prompt = "",
        size = "1k",
        aspect_ratio = "1:1",
        n = 1,
        seed = null,
        response_format = "url",
        num_inference_steps = 50,
        guidance_scale = 4.0,
        cfg_normalization = false,
    } = options;

    const payload = {
        prompt,
        negative_prompt,
        size,
        aspect_ratio,
        n,
        response_format,
        num_inference_steps,
        guidance_scale,
        cfg_normalization,
    };
    if (seed !== null) payload.seed = seed;

    const resp = await fetch(`${BASE_URL}/v1/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    if (resp.status === 503) {
        throw new Error("队列已满，请稍后重试");
    }
    if (!resp.ok) {
        throw new Error(`提交任务失败: ${resp.status} ${await resp.text()}`);
    }

    const result = await resp.json();
    console.log(`任务已提交: ${result.task_id}, 尺寸: ${result.size}`);

    return waitForTask(result.task_id);
}

async function waitForTask(taskId, timeout = 300000, interval = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const resp = await fetch(`${BASE_URL}/v1/tasks/${taskId}`);
        if (!resp.ok) throw new Error(`查询任务失败: ${resp.status}`);

        const data = await resp.json();

        if (data.status === "finished") {
            console.log(`任务完成: ${taskId}`);
            return data;
        } else if (data.status === "failed") {
            throw new Error(`任务失败: ${data.error}`);
        }

        console.log(`状态: ${data.status}... 等待中`);
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`任务超时: ${taskId}`);
}

function saveB64Image(b64Str, filepath) {
    const buffer = Buffer.from(b64Str, "base64");
    fs.writeFileSync(filepath, buffer);
    console.log(`图片已保存: ${filepath}`);
}
```

### 调用示例

```javascript
// 示例1: 基础生成
const result1 = await generateImage({
    prompt: "一只在月光下奔跑的白猫",
});
result1.data.forEach((item) => {
    console.log(`图片URL: ${BASE_URL}${item.url}`);
});

// 示例2: 使用负面提示词
const result2 = await generateImage({
    prompt: "一位优雅的女性站在花园中",
    negative_prompt: "模糊, 变形, 低质量, 水印",
    size: "1k",
    aspect_ratio: "3:4",
});

// 示例3: 1K 16:9 宽屏
const result3 = await generateImage({
    prompt: "赛博朋克城市夜景",
    size: "1k",
    aspect_ratio: "16:9",
});

// 示例4: 720p 竖屏手机壁纸
const result4 = await generateImage({
    prompt: "梦幻星空下的少女",
    size: "720p",
    aspect_ratio: "9:16",
});

// 示例5: 2K 超宽屏 + 指定种子
const result5 = await generateImage({
    prompt: "雪山日出全景",
    size: "2k",
    aspect_ratio: "21:9",
    seed: 42,
});

// 示例6: 自定义尺寸
const result6 = await generateImage({
    prompt: "水彩风格的花卉",
    size: "1280x720",
});

// 示例7: 获取 Base64 并保存
const result7 = await generateImage({
    prompt: "水墨山水画",
    size: "1k",
    aspect_ratio: "3:4",
    response_format: "b64_json",
});
result7.data.forEach((item, i) => {
    saveB64Image(item.b64_json, `output_${i}.png`);
});

// 示例8: 启用 CFG 归一化
const result8 = await generateImage({
    prompt: "超写实人像摄影",
    size: "1k",
    num_inference_steps: 50,
    guidance_scale: 4.0,
    cfg_normalization: true,
});

// 示例9: 批量生成
const result9 = await generateImage({
    prompt: "可爱的柯基犬",
    size: "1k",
    n: 3,
});
```

---

## 七、JavaScript (浏览器) 使用示例

```javascript
const BASE_URL = "http://localhost:8191";

async function generateImage(prompt, options = {}) {
    const payload = {
        prompt,
        negative_prompt: options.negative_prompt || "",
        size: options.size || "1k",
        aspect_ratio: options.aspect_ratio || "1:1",
        n: options.n || 1,
        response_format: options.response_format || "url",
        num_inference_steps: options.num_inference_steps || 50,
        guidance_scale: options.guidance_scale || 4.0,
        cfg_normalization: options.cfg_normalization || false,
    };
    if (options.seed !== undefined) payload.seed = options.seed;

    const resp = await fetch(`${BASE_URL}/v1/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    if (resp.status === 503) {
        throw new Error("队列已满，请稍后重试");
    }

    const result = await resp.json();
    return waitForTask(result.task_id);
}

async function waitForTask(taskId, timeout = 300000, interval = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const resp = await fetch(`${BASE_URL}/v1/tasks/${taskId}`);
        const data = await resp.json();

        if (data.status === "finished") return data;
        if (data.status === "failed") throw new Error(data.error);

        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("任务超时");
}

// 在页面中显示生成的图片
async function main() {
    const result = await generateImage("赛博朋克城市夜景", {
        negative_prompt: "模糊, 低质量",
        size: "1k",
        aspect_ratio: "16:9",
    });

    result.data.forEach((item) => {
        const img = document.createElement("img");
        img.src = `${BASE_URL}${item.url}`;
        img.style.maxWidth = "100%";
        document.body.appendChild(img);
    });
}

main();
```

---

## 八、常见尺寸速查表

| 场景 | size | aspect_ratio | 实际尺寸 |
|------|------|--------------|----------|
| 默认正方形 | `1k` | `1:1` | 1024×1024 |
| 电脑壁纸 | `1k` | `16:9` | 1824×1024 |
| 手机壁纸 | `720p` | `9:16` | 720×1280 |
| 手机壁纸(高清) | `1k` | `9:16` | 1024×1824 |
| 超宽屏壁纸 | `1k` | `21:9` | 2384×1024 |
| 社交媒体横版 | `720p` | `16:9` | 1280×720 |
| 社交媒体竖版 | `720p` | `9:16` | 720×1280 |
| 4:3 照片 | `1k` | `4:3` | 1360×1024 |
| 3:4 人像 | `1k` | `3:4` | 1024×1360 |
| 2K 宽屏 | `2k` | `16:9` | 3648×2048 |
| 2K 正方形 | `2k` | `1:1` | 2048×2048 |
| 自定义 | `1280x720` | (忽略) | 1280×720 |

---

## 九、工作流程说明

```
客户端                        服务端
  │                            │
  │── POST /v1/images/generations ──→  加入队列，返回 task_id
  │                            │
  │── GET /v1/tasks/{task_id} ─────→  返回 queued / processing
  │                            │
  │── GET /v1/tasks/{task_id} ─────→  返回 finished + 图片数据
  │                            │
  │  (轮询间隔建议 2-5 秒)       │
```

- 提交任务后立即返回 `task_id`，需轮询查询结果
- 队列最大容量为 5，满时返回 HTTP 503
- 每张图片生成约需 10-60 秒（取决于分辨率和步数）
- 任务结果默认保留 1 小时后自动清理
