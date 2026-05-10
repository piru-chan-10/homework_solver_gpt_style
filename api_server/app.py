import asyncio
import os
from pathlib import Path

import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from huggingface_hub import InferenceClient
from huggingface_hub.errors import HfHubHTTPError
from pydantic import BaseModel, Field

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
logger = logging.getLogger(__name__)

# Hugging Face Inference API (free tier with account token): https://huggingface.co/settings/tokens
_DEFAULT_MATH = "Qwen/Qwen2.5-7B-Instruct"
_DEFAULT_CODE = "Qwen/Qwen2.5-7B-Instruct"

# Model outputs Markdown; frontend renders LaTeX (KaTeX) and fenced code (highlight.js).
_MARKDOWN_AND_MATH_GUIDE = (
    "Write the full answer in Markdown. "
    "Use `$...$` for inline math and `$$...$$` on its own lines for display equations (LaTeX). "
    "For any code, use fenced blocks with a language tag (e.g. ```python ... ```, ```javascript ... ```). "
    "Use short headings and bullet lists when they clarify the solution."
)

SYSTEM_PROMPTS = {
    "math": (
        "You are an expert math tutor. Solve step by step with clear reasoning; state the final result explicitly. "
        + _MARKDOWN_AND_MATH_GUIDE
    ),
    "code": (
        "You are an expert programming tutor. Give correct code when needed, explain briefly, "
        "and note edge cases or complexity when relevant. "
        + _MARKDOWN_AND_MATH_GUIDE
    ),
    "general": (
        "You are a clear, accurate homework helper. Answer completely and define terms when useful. "
        + _MARKDOWN_AND_MATH_GUIDE
    ),
}


class SolverError(Exception):
    """Raised from worker thread; mapped to HTTPException in the route handler."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


app = FastAPI(title="Homework Solver API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SolveRequest(BaseModel):
    problem: str = Field(..., min_length=1)
    subject: str = Field(..., pattern="^(math|code|general)$")


class SolveResponse(BaseModel):
    solution: str
    subject: str


def _model_for_subject(subject: str) -> str:
    """Pick HF model id; override with env vars."""
    if subject == "code":
        return (
            os.getenv("HF_CODE_MODEL")
            or os.getenv("HF_MODEL")
            or _DEFAULT_CODE
        )
    return os.getenv("HF_MODEL") or _DEFAULT_MATH


def _completion_text(completion) -> str:
    choice = completion.choices[0]
    msg = choice.message
    text = getattr(msg, "content", None)
    if text is None and isinstance(msg, dict):
        text = msg.get("content")
    return (text or "").strip()


def run_hf_solver(subject: str, problem: str) -> str:
    token = os.getenv("HF_TOKEN")
    if not token:
        raise SolverError(
            503,
            (
                "Missing HF_TOKEN. Create a token at https://huggingface.co/settings/tokens "
                "and set the environment variable (Inference API access)."
            ),
        )

    model = _model_for_subject(subject)
    max_tokens = int(os.getenv("HF_MAX_TOKENS", "2048"))
    temperature = float(os.getenv("HF_TEMPERATURE", "0.2"))
    hf_timeout = float(os.getenv("HF_TIMEOUT", "120"))

    client = InferenceClient(model=model, token=token, timeout=hf_timeout)
    system = SYSTEM_PROMPTS.get(subject, SYSTEM_PROMPTS["general"])
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": problem},
    ]

    try:
        completion = client.chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )
    except HfHubHTTPError as e:
        raise SolverError(
            502,
            f"Hugging Face inference failed ({model}): {e}",
        ) from e
    except Exception as e:
        raise SolverError(502, f"Inference error: {e}") from e

    text = _completion_text(completion)
    if not text:
        raise SolverError(
            502,
            "Model returned an empty response. Try another HF_MODEL or shorten the prompt.",
        )
    return text


@app.get("/health")
def health():
    return {"status": "ok", "hf_configured": bool(os.getenv("HF_TOKEN"))}


@app.post("/solve", response_model=SolveResponse)
async def solve(body: SolveRequest):
    """
    Runs HF inference in a thread pool so long model calls do not block other requests
    (e.g. loading the static UI).
    """
    route_timeout = float(os.getenv("SOLVE_ROUTE_TIMEOUT", "180"))
    try:
        solution = await asyncio.wait_for(
            asyncio.to_thread(run_hf_solver, body.subject, body.problem),
            timeout=route_timeout,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=(
                f"Inference exceeded {route_timeout}s (SOLVE_ROUTE_TIMEOUT). "
                "Try HF_TIMEOUT/HF_MAX_TOKENS or a faster HF_MODEL."
            ),
        ) from None
    except SolverError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail) from e

    return SolveResponse(solution=solution, subject=body.subject)


_frontend_root = FRONTEND_DIR.resolve()
if not (_frontend_root / "index.html").is_file():
    logger.warning(
        "Frontend index.html not found at %s — open the app only after fixing paths.",
        _frontend_root,
    )

# Mount last so /health and POST /solve win; StaticFiles serves /, *.css, *.js, and html=True → index.html.
app.mount(
    "/",
    StaticFiles(directory=str(_frontend_root), html=True),
    name="frontend",
)
