// server.js — Node 12 compat (CommonJS), Assistants API v2, sem optional chaining
const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const fs = require("fs");

// Polyfills para Node < 18
const fetch = require("node-fetch");       // v2.x (CommonJS)
const FormData = require("form-data");

dotenv.config();

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID  = process.env.ASSISTANT_ID;
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "whisper-1";

// ---------- util ----------
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractText(messagesData) {
  var result = "(sem resposta)";
  if (!messagesData || !messagesData.data || !messagesData.data.length) return result;

  // A API retorna mensagens em ordem decrescente (mais recente primeiro)
  var last = messagesData.data[0];
  if (!last || !last.content || !Array.isArray(last.content)) return result;

  for (var i = 0; i < last.content.length; i++) {
    var c = last.content[i];

    // v2 mais comum: { type: "output_text", text: { value: "..." } }
    if (c && c.type === "output_text" && c.text && typeof c.text.value === "string") {
      return c.text.value;
    }
    // fallback: { type: "text", text: "..." }
    if (c && c.type === "text" && typeof c.text === "string") {
      return c.text;
    }
    // outros formatos possíveis
    if (c && c.text && typeof c.text.value === "string") {
      return c.text.value;
    }
  }
  return result;
}

function cleanReply(txt) {
  if (!txt) return "";
  // remove padrões tipo [4:0†source]
  txt = txt.replace(/\[\d+:\d+†[^\]]+\]/g, "");
  // normaliza espaços
  txt = txt.replace(/\s+/g, " ").trim();
  return txt;
}

// -----------------------------------------
// 🧠 /api/chat — conversa com o Assistant (v2)
// -----------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY não definido no .env" });
    if (!ASSISTANT_ID)  return res.status(500).json({ error: "ASSISTANT_ID não definido no .env" });

    var history = Array.isArray(req.body && req.body.history) ? req.body.history : [];

    // Filtra roles (v2 só aceita 'user' e 'assistant'; 'system' fica nas instruções do Assistant)
    var apiMessages = [];
    for (var i = 0; i < history.length; i++) {
      var m = history[i];
      if (m && (m.role === "user" || m.role === "assistant")) {
        apiMessages.push({ role: m.role, content: m.content });
      }
    }

    // 1) cria thread
    var r1 = await fetch("https://api.openai.com/v1/threads", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({ messages: apiMessages })
    });
    var threadData = await r1.json();
    if (!r1.ok) {
      console.error("❌ Erro ao criar thread:", threadData);
      return res.status(r1.status).json(threadData);
    }
    var threadId = threadData.id;
    console.log("🧵 Thread criada:", threadId);

    // 2) inicia run
    var r2 = await fetch("https://api.openai.com/v1/threads/" + threadId + "/runs", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({ assistant_id: ASSISTANT_ID })
    });
    var runData = await r2.json();
    if (!r2.ok) {
      console.error("❌ Erro ao criar run:", runData);
      return res.status(r2.status).json(runData);
    }
    var runId = runData.id;
    console.log("🏃 Run iniciada:", runId);

    // 3) polling até finalizar
    var status = "in_progress";
    while (status === "in_progress" || status === "queued") {
      await sleep(1000);
      var r3 = await fetch("https://api.openai.com/v1/threads/" + threadId + "/runs/" + runId, {
        headers: {
          "Authorization": "Bearer " + OPENAI_API_KEY,
          "OpenAI-Beta": "assistants=v2"
        }
      });
      var runCheck = await r3.json();
      status = runCheck && runCheck.status ? runCheck.status : status;
      console.log("⏳ Status:", status);
    }

    // 4) pega mensagens do thread
    var r4 = await fetch("https://api.openai.com/v1/threads/" + threadId + "/messages", {
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "OpenAI-Beta": "assistants=v2"
      }
    });
    var msgs = await r4.json();
    var outputText = extractText(msgs);
    outputText = cleanReply(outputText);

    console.log("💬 Resposta:", outputText);
    return res.json({ reply: outputText });
  } catch (err) {
    console.error("❌ Server error (assistant run):", err);
    return res.status(500).json({ error: String(err) });
  }
});

// -----------------------------------------
// 🎧 /api/transcribe — Whisper (áudio → texto)
// -----------------------------------------
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  var filePath = req.file && req.file.path;
  if (!filePath) return res.status(400).json({ error: "Arquivo de áudio não enviado" });

  try {
    var form = new FormData();
    form.append("file", fs.createReadStream(filePath), req.file.originalname || "audio");
    form.append("model", TRANSCRIBE_MODEL);

    var r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + OPENAI_API_KEY },
      body: form
    });

    if (!r.ok) {
      var errTxt = await r.text();
      console.error("❌ Erro na transcrição:", errTxt);
      return res.status(r.status).json({ error: errTxt });
    }

    var data = await r.json(); // { text: "..." }
    return res.json({ text: data && data.text ? data.text : "" });
  } catch (err) {
    console.error("❌ Server error (transcribe):", err);
    return res.status(500).json({ error: String(err) });
  } finally {
    try { fs.unlink(filePath, function(){}); } catch(e) {}
  }
});

// -----------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log("✅ Servidor em http://localhost:" + PORT);
});
