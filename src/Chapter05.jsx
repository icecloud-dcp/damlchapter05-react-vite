import React, { useEffect, useRef, useState } from "react";
import './App.css'

/**
 * Chapter 5: Data Visualization — Single Page App (Senior University Level)
 * Runnable Python examples with Pyodide + Matplotlib/Seaborn in-browser.
 *
 * Update (Clipboard fix):
 * - Clipboard API can be blocked by Permissions Policy in sandboxed iframes.
 * - Implemented robust copy utility with fallbacks (navigator.clipboard → execCommand → selection).
 * - Copy button now degrades gracefully and shows inline diagnostics.
 * - Added a small diagnostics panel (optional) to test copy paths.
 */

// -----------------------------
// Utilities
// -----------------------------
const classNames = (...xs) => xs.filter(Boolean).join(" ");

// Robust copy utility with fallbacks
async function safeCopyText(text) {
  // Try modern async clipboard if available & likely allowed
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: "navigator.clipboard" };
    } catch (err) {
      // Fall through to legacy fallback below
    }
  }
  // Fallback: hidden textarea + execCommand('copy')
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Avoid scrolling to bottom
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand && document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return { ok: true, method: "execCommand" };
  } catch (err) {
    // Fall through to final fallback
  }
  // Final fallback: manual selection (best-effort)
  try {
    const sel = window.getSelection();
    const range = document.createRange();
    const tmp = document.createElement("span");
    tmp.textContent = text;
    document.body.appendChild(tmp);
    range.selectNodeContents(tmp);
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand && document.execCommand("copy");
    sel.removeAllRanges();
    document.body.removeChild(tmp);
    if (ok) return { ok: true, method: "selection" };
  } catch {}
  return { ok: false, method: "blocked" };
}

// -----------------------------
// Pyodide Loader (singleton)
// -----------------------------
let _pyodidePromise = null;
async function loadPyodideOnce() {
  if (_pyodidePromise) return _pyodidePromise;
  _pyodidePromise = (async () => {
    if (!window.loadPyodide) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.js";
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    const pyodide = await window.loadPyodide({
      stdin: () => null,
      stdout: () => {},
      stderr: () => {},
    });
    // Core packages
    await pyodide.loadPackage(["numpy", "matplotlib", "pandas", "micropip"]);
    // Try seaborn — some builds include it; otherwise, install via micropip
    try {
      await pyodide.runPythonAsync("import seaborn as sns");
    } catch {
      await pyodide.runPythonAsync(
        "import micropip\nawait micropip.install('seaborn')\nimport seaborn as sns"
      );
    }
    return pyodide;
  })();
  return _pyodidePromise;
}

// -----------------------------
// Code Runner Hook
// -----------------------------
function usePyRunner() {
  const [status, setStatus] = useState("idle"); // idle | loading | ready | running | error
  const [errMsg, setErrMsg] = useState("");
  const pyRef = useRef(null);

  const ensureReady = async () => {
    if (pyRef.current) return pyRef.current;
    setStatus("loading");
    setErrMsg("");
    try {
      pyRef.current = await loadPyodideOnce();
      setStatus("ready");
    } catch (e) {
      console.error(e);
      setErrMsg(String(e?.message || e));
      setStatus("error");
      throw e;
    }
    return pyRef.current;
  };

  const run = async (code) => {
    const py = await ensureReady();
    setStatus("running");
    setErrMsg("");

    // Python header to capture stdout + figures
    const header = `
import sys, io, base64
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

# ---- Seaborn (optional) with offline fallbacks ----
try:
    import seaborn as sns
    _orig_load = sns.load_dataset
    def _safe_load_dataset(name):
        try:
            return _orig_load(name)
        except Exception:
            # Offline/sandbox fallbacks
            if name == 'tips':
                return pd.DataFrame({
                    'total_bill':[16.99,10.34,21.01,23.68,24.59,25.29,8.77,26.88],
                    'tip':[1.01,1.66,3.50,3.31,3.61,4.71,2.00,3.12],
                    'sex':['Female','Male','Male','Male','Female','Male','Female','Male'],
                    'day':['Sun','Sun','Sun','Sun','Sun','Sun','Sat','Sat']
                })
            if name == 'titanic':
                return pd.DataFrame({
                    'survived':[0,1,1,0,1,0,1,0],
                    'pclass':[3,1,3,1,2,3,2,1],
                    'sex':['male','female','female','male','female','male','female','male'],
                    'age':[22,38,26,35,27,28,14,54],
                    'fare':[7.25,71.28,7.92,53.10,10.50,8.05,30.07,51.86],
                    'class':['Third','First','Third','First','Second','Third','Second','First']
                })
            raise
    sns.load_dataset = _safe_load_dataset
    # Preload commonly used datasets so subsequent blocks can reuse
    globals().setdefault('tips', sns.load_dataset('tips'))
    globals().setdefault('titanic', sns.load_dataset('titanic'))
except Exception:
    pass

# ---- stdout capture ----
_stdout_buffer = io.StringIO()
_sys_stdout = sys.stdout
sys.stdout = _stdout_buffer

# ---- Patch plt.show() to emit base64 PNGs ----
_def_show = plt.show
def _capture_show(*args, **kwargs):
    buf = io.BytesIO()
    plt.savefig(buf, format='png', bbox_inches='tight')
    buf.seek(0)
    b64 = base64.b64encode(buf.read()).decode('ascii')
    print('__IMG__' + b64)
    plt.close('all')
plt.show = _capture_show
`;

    const footer = `
# ---- Restore stdout and RETURN captured text (do NOT print) ----
sys.stdout = _sys_stdout
_stdout_buffer.getvalue()
`;

    let images = [];
    let text = "";
    try {
      const out = await py.runPythonAsync(header + "\n" + code + "\n" + footer);
      // Parse the combined stdout: lines starting with __IMG__ are images
      const lines = String(out).split(/\n/);
      for (const line of lines) {
        if (line.startsWith("__IMG__")) {
          const b64 = line.replace("__IMG__", "");
          images.push(`data:image/png;base64,${b64}`);
        } else if (line.trim().length) {
          text += line + "\n";
        }
      }
      setStatus("ready");
      return { images, text };
    } catch (e) {
      console.error(e);
      setErrMsg(String(e?.message || e));
      setStatus("error");
      return { images: [], text: "", error: String(e?.message || e) };
    }
  };

  return { status, errMsg, ensureReady, run };
}

const LoadStateBadge = ({ status }) => {
  let label = "";
  let style = "";
  switch (status) {
    case "idle":
      label = "Idle"; style = "bg-gray-700 text-gray-100"; break;
    case "loading":
      label = "Loading runtime…"; style = "bg-amber-700 text-amber-100"; break;
    case "ready":
      label = "Ready"; style = "bg-emerald-700 text-emerald-100"; break;
    case "running":
      label = "Running"; style = "bg-indigo-700 text-indigo-100"; break;
    case "error":
      label = "Error"; style = "bg-rose-700 text-rose-100"; break;
    default:
      label = status; style = "bg-gray-700 text-gray-100";
  }
  return (
    <span className={classNames("rounded-md px-2 py-1 text-xs", style)}>{label}</span>
  );
};

// Clipboard-aware CopyButton using safeCopyText()
const CopyButton = ({ text, label = "Copy" }) => {
  const [state, setState] = useState({ ok: false, method: null, error: null });
  const [busy, setBusy] = useState(false);

  const handleCopy = async () => {
    setBusy(true);
    try {
      const res = await safeCopyText(text);
      if (res.ok) setState({ ok: true, method: res.method, error: null });
      else setState({ ok: false, method: res.method, error: "Clipboard blocked by policy" });
      setTimeout(() => setState((s) => ({ ...s, ok: false })), 1200);
    } catch (e) {
      setState({ ok: false, method: null, error: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inline-flex items-center gap-2">
      <button
        onClick={handleCopy}
        disabled={busy}
        className={classNames(
          "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm",
          state.ok ? "bg-emerald-700 text-white" : "bg-gray-700 text-gray-100 hover:bg-gray-600",
          busy && "opacity-70"
        )}
        title="Copy to clipboard"
      >
        <span className="i-lucide-clipboard mr-1">📋</span>
        {state.ok ? `Copied (${state.method})` : label}
      </button>
      {state.error && (
        <span className="text-[10px] text-amber-300">{state.error}</span>
      )}
    </div>
  );
};

const Spinner = () => (
  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
  </svg>
);

const CodeBlock = ({ code, label = "Run" }) => {
  const { status, errMsg, ensureReady, run } = usePyRunner();
  const [out, setOut] = useState({ images: [], text: "" });
  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);

  const onRun = async () => {
    setRunning(true);
    try {
      const result = await run(code);
      setOut(result);
      setHasRun(true);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="group rounded-xl border border-white/10 bg-black/60 p-3 ring-1 ring-white/10">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex gap-2">
          <CopyButton text={code} />
          <button
            onClick={onRun}
            disabled={running || status === 'loading'}
            className={classNames(
              "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium",
              running ? "bg-indigo-900 text-indigo-200" : "bg-indigo-600 text-white hover:bg-indigo-500"
            )}
            title="Run this code"
          >
            {running ? (<><Spinner /><span>Running…</span></>) : label}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <LoadStateBadge status={status} />
          {status === 'idle' && (
            <button
              onClick={ensureReady}
              className="rounded-md bg-gray-700 px-2 py-1 text-xs text-gray-100 hover:bg-gray-600"
              title="Preload Python runtime"
            >
              Load runtime
            </button>
          )}
        </div>
      </div>

      <pre className="relative overflow-auto rounded-lg bg-black/70 p-4 text-sm leading-relaxed"><code>{code}</code></pre>

      {/* Output */}
      <div className="mt-3 rounded-lg border border-white/10 bg-gray-900/50 p-3">
        <p className="mb-2 text-xs font-semibold text-gray-200">Output</p>
        {!hasRun && (
          <p className="text-xs text-gray-400">No output yet. Click <span className="rounded bg-gray-800 px-1 py-0.5">Run</span> to execute and display results here.</p>
        )}
        {out.text?.trim()?.length ? (
          <pre className="mt-2 rounded-md bg-gray-900/70 p-3 text-xs text-gray-100">{out.text}</pre>
        ) : null}
        {out.images?.length ? (
          <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
            {out.images.map((src, i) => (
              <img key={i} src={src} alt={`figure-${i + 1}`} className="w-full rounded-md border border-white/10" />
            ))}
          </div>
        ) : null}
        {status === "error" && errMsg && (
          <div className="mt-2 rounded-md bg-rose-900/40 p-3 text-xs text-rose-100">{String(errMsg)}</div>
        )}
      </div>
    </div>
  );
};

// Simple 80-minute countdown timer
const useCountdown = (minutes = 80) => {
  const [secsLeft, setSecsLeft] = useState(minutes * 60);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSecsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [running]);
  const reset = () => setSecsLeft(minutes * 60);
  const mm = Math.floor(secsLeft / 60).toString().padStart(2, "0");
  const ss = (secsLeft % 60).toString().padStart(2, "0");
  return { secsLeft, display: `${mm}:${ss}`, running, setRunning, reset };
};

// -----------------------------
// Content (codes and text)
// -----------------------------
const codeIntroLine = `import matplotlib.pyplot as plt\nplt.plot([1,2,3,4],[10,20,25,30])\nplt.title('Simple Line Plot')\nplt.show()`;

const codeBasicScatter = `import matplotlib.pyplot as plt\nimport numpy as np\n\nx = np.random.rand(50)\ny = np.random.rand(50)\n\nplt.scatter(x, y, color='blue', marker='o')\nplt.title('Scatter Plot Example')\nplt.xlabel('X-axis')\nplt.ylabel('Y-axis')\nplt.show()`;

const codeBasicLine = `import numpy as np\nimport matplotlib.pyplot as plt\n\nx = np.linspace(0, 10, 100)\ny = np.sin(x)\n\nplt.plot(x, y, color='green', label='sin(x)')\nplt.title('Line Plot of sin(x)')\nplt.legend()\nplt.show()`;

const codeBasicBar = `import matplotlib.pyplot as plt\n\ncategories = ['A','B','C']\nvalues = [5,7,3]\n\nplt.bar(categories, values, color='purple')\nplt.title('Bar Chart Example')\nplt.xlabel('Category')\nplt.ylabel('Value')\nplt.show()`;

const codeBasicHist = `import numpy as np\nimport matplotlib.pyplot as plt\n\ndata = np.random.randn(1000)\nplt.hist(data, bins=20, color='orange')\nplt.title('Histogram of Random Data')\nplt.xlabel('Value')\nplt.ylabel('Frequency')\nplt.show()`;

const codeBasicPie = `import matplotlib.pyplot as plt\n\nsizes = [15, 30, 45, 10]\nlabels = ['A','B','C','D']\n\nplt.pie(sizes, labels=labels, autopct='%1.1f%%', startangle=90)\nplt.title('Pie Chart Example')\nplt.show()`;

const codeEnhanceTitles = `import numpy as np\nimport matplotlib.pyplot as plt\n\nx = np.linspace(0, 10, 100)\nplt.plot(x, np.sin(x), label='sin(x)', color='red')\nplt.title('Enhanced Line Plot')\nplt.xlabel('X-axis')\nplt.ylabel('Y-axis')\nplt.legend()\nplt.grid(True, alpha=0.3)\nplt.show()`;

const codeSubplots = `import numpy as np\nimport matplotlib.pyplot as plt\n\nx = np.linspace(0, 10, 100)\nplt.figure(figsize=(10, 5))\n\nplt.subplot(2, 1, 1)\nplt.plot(x, np.sin(x), 'b')\nplt.title('Sine')\n\nplt.subplot(2, 1, 2)\nplt.plot(x, np.cos(x), 'r')\nplt.title('Cosine')\nplt.tight_layout()\nplt.show()`;

const codeAnnotations = `import numpy as np\nimport matplotlib.pyplot as plt\n\nx = np.linspace(0, 10, 100)\nplt.plot(x, np.sin(x))\nplt.annotate('Peak', xy=(np.pi/2, 1), xytext=(5, 1.5),\n             arrowprops=dict(facecolor='black'))\nplt.title('Annotated Sine Wave')\nplt.show()`;

const codePracticeEnhance = `import matplotlib.pyplot as plt\nmonths = ['Jan','Feb','Mar','Apr','May']\nsales_A = [100,120,130,90,150]\nsales_B = [90,110,140,120,160]\n\nplt.plot(months, sales_A, label='Product A', marker='o')\nplt.plot(months, sales_B, label='Product B', marker='s')\nplt.title('Monthly Sales Comparison')\nplt.xlabel('Month')\nplt.ylabel('Sales')\nplt.legend()\nplt.grid(True)\nplt.show()`;

const codeSeabornSetup = `import seaborn as sns\nimport matplotlib.pyplot as plt\nimport pandas as pd\n\ntips = sns.load_dataset('tips')\nprint(tips.head())`;

const codeSeabornBar = `import seaborn as sns\nimport matplotlib.pyplot as plt\n\nsns.barplot(x='day', y='total_bill', hue='sex', data=tips)\nplt.title('Bar Plot of Total Bill by Day')\nplt.show()`;

const codeSeabornDist = `import seaborn as sns\nimport matplotlib.pyplot as plt\n\nsns.histplot(tips['total_bill'], kde=True)\nplt.title('Distribution of Total Bill')\nplt.show()`;

const codeSeabornHeatmap = `import seaborn as sns\nimport matplotlib.pyplot as plt\n\ncorr = tips.corr(numeric_only=True)\nsns.heatmap(corr, annot=True, cmap='viridis')\nplt.title('Correlation Heatmap')\nplt.show()`;

const codeSeabornBox = `import seaborn as sns\nimport matplotlib.pyplot as plt\n\nsns.boxplot(x='day', y='tip', data=tips)\nplt.title('Box Plot of Tips by Day')\nplt.show()`;

const codeSeabornPair = `import seaborn as sns\nimport matplotlib.pyplot as plt\n\nsns.pairplot(tips, hue='sex', diag_kind='kde')\nplt.suptitle('Pairwise Relationships in Tips Dataset', y=1.02)\nplt.show()`;

const codePracticeReal = `import seaborn as sns\nimport matplotlib.pyplot as plt\n\ntitanic = sns.load_dataset('titanic')\n\n# Count plot\nsns.countplot(x='class', hue='survived', data=titanic)\nplt.title('Survival Count by Class')\nplt.show()\n\n# Correlation heatmap (numeric only)\ncorr = titanic.corr(numeric_only=True)\nsns.heatmap(corr, annot=True, cmap='coolwarm')\nplt.title('Correlation Heatmap - Titanic')\nplt.show()`;

const studyTips = [
  "Label axes and add legends; avoid chartjunk.",
  "Choose colormaps by data type: sequential vs. diverging vs. categorical.",
  "Use subplots to compare facets; annotate key takeaways.",
  "Sanity-check scales, bins, and aspect ratios.",
  "Ask: What question does this chart answer?"
];

const quiz = [
  {
    q: "Which plot is best for showing the distribution of a single continuous variable?",
    choices: ["Scatter", "Histogram", "Line", "Pie"],
    a: 1,
    explain: "Histograms bin values to show distribution; KDE adds smooth density."
  },
  {
    q: "When should you prefer a diverging colormap?",
    choices: [
      "For ordinal categories",
      "When values are centered around a meaningful midpoint (e.g., 0)",
      "For strictly increasing sequences",
      "When data are binary"
    ],
    a: 1,
    explain: "Diverging colormaps highlight deviations above/below a center."
  },
  {
    q: "What does sns.pairplot() help you see?",
    choices: [
      "Time-series seasonality",
      "Pairwise relationships across multiple numeric variables",
      "Model feature importances",
      "Exact p-values of correlations"
    ],
    a: 1,
    explain: "Pairplot reveals scatter distributions and univariate diagonals across many features."
  }
];

function QuizBlock() {
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  return (
    <div className="space-y-4">
      {quiz.map((item, idx) => {
        const selected = answers[idx];
        const correct = submitted && selected === item.a;
        const wrong = submitted && selected !== undefined && selected !== item.a;
        return (
          <div key={idx} className="rounded-xl border border-white/10 bg-gray-800/50 p-4">
            <p className="mb-2 font-medium">Q{idx + 1}. {item.q}</p>
            <div className="space-y-1">
              {item.choices.map((c, cidx) => (
                <label key={cidx} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`q${idx}`}
                    checked={answers[idx] === cidx}
                    onChange={() => setAnswers({ ...answers, [idx]: cidx })}
                  />
                  <span className="text-sm">{c}</span>
                </label>
              ))}
            </div>
            {submitted && (
              <div className={classNames("mt-2 text-sm", correct ? "text-emerald-400" : wrong ? "text-rose-400" : "text-gray-300")}
              >
                {correct ? "✅ Correct." : wrong ? `❌ Incorrect. ${item.explain}` : item.explain}
              </div>
            )}
          </div>
        );
      })}
      <div className="flex gap-3">
        <button
          onClick={() => setSubmitted(true)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Submit
        </button>
        <button
          onClick={() => { setAnswers({}); setSubmitted(false); }}
          className="rounded-lg bg-gray-700 px-4 py-2 text-sm text-gray-100 hover:bg-gray-600"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

// -----------------------------
// UI Primitives
// -----------------------------
const Section = ({ id, title, children, defaultOpen = true, duration }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section id={id} className="scroll-mt-24 mb-6">
      <div
        className={classNames(
          "flex items-center justify-between rounded-2xl px-4 py-3",
          open ? "bg-gray-900/70" : "bg-gray-800/80",
          "ring-1 ring-white/10 shadow"
        )}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => setOpen((s) => !s)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-gray-700/80 hover:bg-gray-600/80"
            aria-label={open ? "Collapse" : "Expand"}
            title={open ? "Collapse" : "Expand"}
          >
            <span className="text-lg select-none">{open ? "−" : "+"}</span>
          </button>
          <h2 className="text-xl font-semibold">{title}</h2>
        </div>
        {duration !== undefined && (
          <span className="text-xs text-gray-300">{duration} min</span>
        )}
      </div>
      {open && (
        <div className="rounded-b-2xl border-x border-b border-white/10 bg-gray-900/40 p-4">
          {children}
        </div>
      )}
    </section>
  );
};

// -----------------------------
// Diagnostics (simple test cases for clipboard paths)
// -----------------------------
function ClipboardDiagnostics() {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const sample = "Clipboard test: 12345 ✓";

  const run = async () => {
    setBusy(true);
    const res = await safeCopyText(sample);
    setResult(res);
    setBusy(false);
  };

  return (
    <div className="mt-6 rounded-xl border border-white/10 bg-gray-900/50 p-3 text-xs text-gray-200">
      <div className="mb-2 font-semibold">Clipboard Diagnostics</div>
      <div className="mb-2">This tries multiple copy methods. If your environment blocks clipboard, you'll see a message.</div>
      <button
        onClick={run}
        disabled={busy}
        className="rounded-md bg-gray-700 px-3 py-1.5 text-xs hover:bg-gray-600"
      >
        {busy ? "Testing…" : "Run clipboard test"}
      </button>
      {result && (
        <div className="mt-2">
          <div>ok: <span className={classNames(result.ok ? "text-emerald-400" : "text-rose-400")}>{String(result.ok)}</span></div>
          <div>method: <span className="text-amber-300">{result.method}</span></div>
        </div>
      )}
    </div>
  );
}

// -----------------------------
// Main App
// -----------------------------
export default function App() {
  const toc = [
    { id: "intro", label: "1. Introduction", dur: 10 },
    { id: "basic", label: "2. Basic Plots (Matplotlib)", dur: 20 },
    { id: "enhance", label: "3. Enhancing Plots", dur: 15 },
    { id: "practice-enhance", label: "4. Practice: Enhancing", dur: 10 },
    { id: "seaborn", label: "5. Advanced (Seaborn)", dur: 20 },
    { id: "practice-real", label: "6. Practice: Real Dataset", dur: 5 },
    { id: "summary", label: "7. Summary & Quiz", dur: 0 },
  ];
  const { display, running, setRunning, reset } = useCountdown(80);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-900 to-black text-gray-100">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-indigo-600/80 shadow" />
            <div>
              <h1 className="text-lg font-semibold">Chapter 5: Data Visualization</h1>
              <p className="text-xs text-gray-300">Senior Level • 80-minute lecture</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-gray-800 px-3 py-1 text-sm ring-1 ring-white/10">⏱ {display}</span>
            <button
              onClick={() => setRunning((s) => !s)}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
            >
              {running ? "Pause" : "Start"}
            </button>
            <button
              onClick={reset}
              className="rounded-lg bg-gray-700 px-3 py-1.5 text-sm text-gray-100 hover:bg-gray-600"
            >
              Reset
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 md:grid-cols-[260px_1fr]">
        {/* TOC */}
        <nav className="hidden md:block">
          <div className="sticky top-[4.5rem] space-y-2">
            <div className="rounded-2xl border border-white/10 bg-gray-900/60 p-3">
              <p className="mb-2 text-sm font-semibold text-gray-200">Outline</p>
              <ul className="space-y-1 text-sm">
                {toc.map((t) => (
                  <li key={t.id}>
                    <a
                      href={`#${t.id}`}
                      className="block rounded-lg px-2 py-1 text-gray-300 hover:bg-gray-800 hover:text-white"
                    >
                      {t.label}
                      {t.dur ? <span className="ml-2 text-xs text-gray-400">({t.dur}m)</span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-white/10 bg-gray-900/60 p-3">
              <p className="mb-2 text-sm font-semibold text-gray-200">Study Tips</p>
              <ul className="list-disc pl-5 text-sm text-gray-300">
                {studyTips.map((s, i) => (
                  <li key={i} className="mb-1">{s}</li>
                ))}
              </ul>
            </div>
          </div>
        </nav>

        {/* Content */}
        <div className="space-y-6">
          <Section id="intro" title="1) Introduction to Data Visualization" duration={10}>
            <p className="mb-3 text-sm text-gray-300">
              Visualization represents data graphically to reveal trends, patterns, and outliers. In Python, we rely on
              <span className="mx-1 rounded bg-gray-800 px-1.5 py-0.5">Matplotlib</span> as the foundation and
              <span className="mx-1 rounded bg-gray-800 px-1.5 py-0.5">Seaborn</span> for statistical high-level plots.
            </p>
            <CodeBlock code={codeIntroLine} />
          </Section>

          <Section id="basic" title="2) Basic Plots with Matplotlib" duration={20}>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-2 font-medium">Scatter</h3>
                <CodeBlock code={codeBasicScatter} />
              </div>
              <div>
                <h3 className="mb-2 font-medium">Line</h3>
                <CodeBlock code={codeBasicLine} />
              </div>
              <div>
                <h3 className="mb-2 font-medium">Bar</h3>
                <CodeBlock code={codeBasicBar} />
              </div>
              <div>
                <h3 className="mb-2 font-medium">Histogram</h3>
                <CodeBlock code={codeBasicHist} />
              </div>
              <div className="md:col-span-2">
                <h3 className="mb-2 font-medium">Pie</h3>
                <CodeBlock code={codeBasicPie} />
              </div>
            </div>
          </Section>

          <Section id="enhance" title="3) Enhancing Plots with Matplotlib" duration={15}>
            <p className="mb-3 text-sm text-gray-300">
              Titles, labels, legends, annotations, and subplots turn charts into readable stories. Keep scales consistent
              and annotate the key insight.
            </p>
            <div className="space-y-4">
              <div>
                <h3 className="mb-2 font-medium">Titles / Labels / Legend / Grid</h3>
                <CodeBlock code={codeEnhanceTitles} />
              </div>
              <div>
                <h3 className="mb-2 font-medium">Subplots</h3>
                <CodeBlock code={codeSubplots} />
              </div>
              <div>
                <h3 className="mb-2 font-medium">Annotations</h3>
                <CodeBlock code={codeAnnotations} />
              </div>
            </div>
          </Section>

          <Section id="practice-enhance" title="4) Practice Codes: Enhancing Matplotlib" duration={10}>
            <p className="mb-3 text-sm text-gray-300">Practice combining elements (markers, grid, legend) for comparative stories.</p>
            <CodeBlock code={codePracticeEnhance} />
          </Section>

          <Section id="seaborn" title="5) Advanced Visualization Techniques with Seaborn" duration={20}>
            <p className="mb-3 text-sm text-gray-300">Seaborn offers high-level statistical plots and cleaner defaults.</p>
            <div className="space-y-4">
              <div>
                <h3 className="mb-2 font-medium">Setup & Inspect</h3>
                <CodeBlock code={codeSeabornSetup} />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3 className="mb-2 font-medium">Bar Plot</h3>
                  <CodeBlock code={codeSeabornBar} />
                </div>
                <div>
                  <h3 className="mb-2 font-medium">Distribution (histplot + KDE)</h3>
                  <CodeBlock code={codeSeabornDist} />
                </div>
                <div>
                  <h3 className="mb-2 font-medium">Heatmap (correlation)</h3>
                  <CodeBlock code={codeSeabornHeatmap} />
                </div>
                <div>
                  <h3 className="mb-2 font-medium">Box Plot</h3>
                  <CodeBlock code={codeSeabornBox} />
                </div>
              </div>
              <div>
                <h3 className="mb-2 font-medium">Pair Plot</h3>
                <CodeBlock code={codeSeabornPair} />
              </div>
            </div>
          </Section>

          <Section id="practice-real" title="6) Practice: Real Dataset (Titanic)" duration={5}>
            <p className="mb-3 text-sm text-gray-300">Use Seaborn's built-in datasets to explore real data quickly.</p>
            <CodeBlock code={codePracticeReal} />
          </Section>

          <Section id="summary" title="7) Summary & Quiz" defaultOpen={true}>
            <ul className="mb-4 list-disc pl-6 text-sm text-gray-300">
              <li>Matplotlib provides flexible, low-level control over plots.</li>
              <li>Seaborn simplifies statistical visualizations with better defaults.</li>
              <li>Design for clarity: appropriate chart type, labeling, and color choice.</li>
            </ul>
            <QuizBlock />
            <div className="mt-6 rounded-xl border border-white/10 bg-gray-800/40 p-4 text-sm text-gray-300">
              <p className="mb-2 font-medium">Mini-Assignment</p>
              <ol className="list-decimal pl-6">
                <li>Choose a Kaggle dataset (or any CSV you have).</li>
                <li>Create at least three plot types (scatter, box, heatmap) with clear labels and legends.</li>
                <li>Add at least one annotation that highlights a key insight.</li>
              </ol>
              <ClipboardDiagnostics />
            </div>
          </Section>
        </div>
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-2 text-center text-xs text-gray-400">
        © {new Date().getFullYear()} Chapter 5 • Data Visualization | Lecture SPA
      </footer>
    </div>
  );
}
