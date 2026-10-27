# LectureMate AI

**A timestamp-aware AI assistant for understanding and revising recorded lectures.**

LectureMate AI is a learning-support project designed to help students ask questions about lecture videos, find relevant transcript passages, and create revision materials. The system is designed to retrieve relevant lecture transcript segments and provide them as context to a language model.

> **Project status:** This README describes the intended architecture and features discussed during development. Before publishing, verify each feature against the current code and mark unfinished or untested features accordingly.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Objectives](#objectives)
- [Features](#features)
- [Technology Stack](#technology-stack)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Installation and Setup](#installation-and-setup)
- [Configuration](#configuration)
- [Evaluation and Testing](#evaluation-and-testing)
- [Privacy and Security](#privacy-and-security)
- [Limitations and Future Work](#limitations-and-future-work)
- [License](#license)

## Problem Statement

Recorded lectures can be long, and students may spend considerable time finding the exact explanation they need. General-purpose chatbots may also provide answers that are not grounded in the lecture being studied.

LectureMate AI explores a lecture-focused workflow: process a video's transcript, retrieve relevant sections for a question, and use those sections to help generate a contextual answer.

## Objectives

- Make lecture content easier to search and understand.
- Retrieve relevant transcript passages for a learner's question.
- Use timestamps to connect answers with the lecture timeline where supported.
- Support revision through generated study materials.
- Provide a web interface for interacting with lecture content.
- Support user accounts and per-user data separation where implemented and tested.

## Features

Verify each feature in the current version before describing it as complete.

- **Lecture question answering:** Ask questions about a lecture using transcript context.
- **Timestamp-aware context:** Associate transcript segments with timestamps.
- **Transcript ingestion:** Prefer available YouTube captions, with speech-to-text fallback where configured.
- **Retrieval-Augmented Generation (RAG):** Retrieve relevant transcript segments before generating an answer.
- **LLM options:** The project has explored hosted providers such as Groq and Gemini, and local inference through Ollama. Availability depends on current code and configuration.
- **Study materials:** Notes, quizzes, flashcards, and mind maps where supported by the current code.
- **Chat and saved content:** History and persistence depend on implemented endpoints and database behavior.
- **Authentication:** Verify registration, login, logout, and per-user access controls before describing them as production-ready.

## Technology Stack

| Layer | Technology | Role |
|---|---|---|
| Frontend | React, TypeScript, Vite | User interface |
| Backend | Python, FastAPI | API endpoints and application logic |
| Database | SQLite | Local relational storage |
| Semantic retrieval | Sentence Transformers, FAISS (where configured) | Embeddings and similarity search |
| Transcription | YouTube captions and Whisper fallback (where configured) | Obtain lecture text |
| Language model | Configured provider such as Groq, Gemini, or Ollama | Generate answers and study content |

Exact dependencies and supported providers are determined by the repository's current dependency and configuration files.

## How It Works

1. **Add a lecture:** The user supplies a supported lecture/video source.
2. **Obtain transcript:** The backend attempts to obtain captions or uses a configured transcription fallback.
3. **Prepare transcript segments:** Text is divided into smaller segments associated with timestamps.
4. **Create embeddings:** A sentence-embedding model represents transcript segments as vectors.
5. **Retrieve relevant context:** The question is compared with transcript segments to select relevant passages.
6. **Generate a response:** The backend sends the question and retrieved context to the configured language model.
7. **Display the result:** The frontend displays the answer and, where supported, related timestamps or study materials.
8. **Persist supported data:** Applicable records are stored in SQLite according to the current implementation.

### What is RAG?

Retrieval-Augmented Generation (RAG) combines information retrieval with language-model generation. In this project, retrieval is intended to find relevant lecture transcript passages first. Those passages are then supplied to the language model so that its answer can be grounded in lecture content instead of relying only on its general training.

## Architecture

```text
Learner
   |
   v
React + TypeScript + Vite
   |
   v
FastAPI backend
   |
   +--> Transcript / caption processing
   |
   +--> Text segmentation and embeddings
   |
   +--> Similarity retrieval (FAISS, if configured)
   |
   +--> LLM provider (hosted or local)
   |
   +--> SQLite persistence (supported records)
   |
   v
Answer and supported study materials
   |
   v
Frontend display
```

## Example Project Structure

Use your repository's real folder names; this is only an example.

```text
lecture-mate/
├── frontend/             # React + TypeScript + Vite application
├── backend/              # FastAPI application
├── docs/                 # Architecture diagrams and documentation
├── tests/                # Automated tests, if present
├── README.md
└── .gitignore
```

In the development setup, the frontend has been run on `http://localhost:5173` and the backend on `http://127.0.0.1:8000`. Actual ports may differ based on configuration.

## Requirements

- Python
- Node.js and npm
- Git
- A supported language-model provider or local model runtime, depending on configuration
- Optional resources required by the selected transcription or embedding models

Use the versions specified in your dependency files, where available.

## Installation and Setup

These are general instructions. Adapt paths and commands to match the actual repository.

### 1. Clone the repository

```bash
git clone https://github.com/YOUR-USERNAME/lecture-mate.git
cd lecture-mate
```

Replace `YOUR-USERNAME` with your GitHub username.

### 2. Set up the backend

```bash
cd backend
python -m venv .venv
```

Activate the environment on Windows PowerShell:

```powershell
.venv\Scripts\Activate.ps1
```

Or in Command Prompt:

```bat
.venv\Scripts\activate.bat
```

If `requirements.txt` exists, install dependencies:

```bash
pip install -r requirements.txt
```

Start FastAPI using the actual application import path. For example, if the entry point is `app.main:app`:

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

If Swagger is enabled, the API documentation is usually available at `http://127.0.0.1:8000/docs`.

### 3. Set up the frontend

Open a second terminal in the frontend directory:

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, commonly `http://localhost:5173`.

If `package.json` is at the repository root rather than inside `frontend/`, run the frontend commands from the root.

## Configuration

Some features require API keys or local model configuration. Check the code for the exact environment variable names and settings that the current version reads.

- Never commit real API keys, passwords, tokens, database credentials, or private URLs.
- If the project uses a `.env` file, include a `.env.example` with placeholder values only.
- Do not guess environment variable names; confirm them from the code.
- For local inference, install the required model runtime and download the model separately.
- Avoid logging provider keys.

## Evaluation and Testing

Test the application before reporting performance numbers.

- **Retrieval relevance:** Does the retrieved transcript contain the information needed to answer the question?
- **Answer faithfulness:** Does the answer stay consistent with retrieved lecture context?
- **Timestamp accuracy:** Do timestamps point to the relevant part of the lecture?
- **Response time:** Measure processing and answer-generation latency.
- **Transcription quality:** Compare generated transcripts with the spoken content.
- **Account isolation:** Confirm one account cannot access another account's videos, chats, notes, or settings.
- **Study-material quality:** Check quiz answers, flashcard accuracy, and mind-map relationships.
- **Error handling:** Test unavailable captions, transcription failures, invalid provider keys, and model errors.

If using RAGAS or another evaluation framework, report the dataset, metrics, configuration, and measured results. Do not publish unmeasured or illustrative values as real results.

## Privacy and Security

Before publishing or deploying the project:

- Keep API keys and credentials out of Git.
- Exclude local databases that contain real user data.
- Use secure password hashing; never store plain-text passwords.
- Enforce authorization checks on every user-owned resource, not only in the frontend.
- Test account isolation using separate test accounts.
- Do not commit private lecture videos, transcripts, chat logs, or personal information.
- Review logs and error messages for secrets.
- Do not describe authentication as production-ready until access-control tests pass.

## Limitations and Future Work

Potential areas for improvement include:

- Improve retrieval for short, ambiguous, or multilingual questions.
- Improve transcript quality and timestamp alignment.
- Evaluate retrieval and answer faithfulness on a documented test set.
- Strengthen automated tests for authentication and per-user data isolation.
- Improve caching for repeated video requests.
- Improve visualization and accessibility of generated study materials.
- Add deployment guidance and scalable storage if cloud access is required.

Only list an item as future work if it is not already implemented to the required standard.

## Contributing

1. Describe the issue or proposed change.
2. Explain how the change can be tested.
3. Keep secrets and private data out of commits.
4. Include tests for changes to retrieval, authentication, persistence, or API behavior where practical.

## License

Choose a license before making the repository public. If you want others to reuse and modify the code, the MIT License may be suitable if you have the right to license all included code and assets. If you have not selected a license, leave this section pending rather than implying that a license is already in place.
