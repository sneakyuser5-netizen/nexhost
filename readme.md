# NEXHOST

Universal Node.js Bot Hosting Platform.

## Current status

This repository is a working, early-stage bot hosting application with a Node.js/Express backend, SQLite-based persistence, and a static frontend dashboard. The project is actively structured around bot lifecycle management: registration, authentication, source upload, deployment tracking, and process control.

The codebase currently includes:

- Express API server with security middleware and rate limiting
- User authentication and session handling
- Bot CRUD operations and deployment history
- Bot archive upload processing with validation
- Runtime management for starting, stopping, restarting, and monitoring bot processes
- Static web UI served from the `public/` directory
- SQLite database integration for persistent metadata

## Tech stack

- JavaScript / Node.js
- Express
- SQLite
- Helmet + Express rate limiting
- Multer for file uploads
- dotenv for environment configuration

## Project structure

```text
.
├── .env.example
├── .gitignore
├── database/
│   ├── check.js
│   └── db.js
├── public/
│   ├── css/
│   ├── js/
│   └── index.html
├── server/
│   ├── app.js
│   ├── index.js
│   ├── controllers/
│   ├── middleware/
│   ├── routes/
│   └── services/
├── package.json
├── package-lock.json
└── storage/
```

## Core features

### Authentication
The API includes a user auth flow for:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`

### Bot management
Bot lifecycle operations are exposed through:

- `POST /api/bots/`
- `GET /api/bots/`
- `GET /api/bots/:id`
- `PATCH /api/bots/:id`
- `DELETE /api/bots/:id`

### Bot deployment and runtime
The platform includes process control and deployment features:

- `POST /api/bots/:id/upload`
- `POST /api/bots/:id/start`
- `POST /api/bots/:id/stop`
- `POST /api/bots/:id/restart`
- `GET /api/bots/:id/status`
- `GET /api/bots/:id/resources`
- `GET /api/bots/:id/deployments`
- `GET /api/bots/:id/logs`

### Health check

- `GET /api/health`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment variables:

```bash
cp .env.example .env
```

Example configuration:

```env
PORT=3000
NODE_ENV=development
```

3. Start the server:

```bash
npm run dev
```

or:

```bash
npm start
```

## Runtime notes

- The application is currently configured to launch on `127.0.0.1` on the configured port.
- The server initializes session cleanup and stale bot recovery when starting.
- The app is designed for local development and service hosting workflows rather than a production-ready multi-tenant deployment stack.
- There is no test suite configured yet; the current `test` script is still a placeholder.

## Repository status summary

This project is best described as an operational MVP / early prototype for a Node.js bot hosting platform. The foundations for user auth, bot management, uploads, and runtime orchestration are present, but further hardening, production configuration, observability, testing, and deployment automation would be needed before broad production use.

## License

Package metadata declares the project license as `ISC`.
