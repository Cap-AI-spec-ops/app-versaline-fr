# Chat Assistant MVP Spec (Versaline)

## Objective
Ship a first in-app assistant that:
- opens from a floating bottom-right button,
- answers with workspace-scoped context only,
- charges a fixed 0.1 credit per user message,
- runs through a server route (`/api/chat-assistant`) with provider/model resolved from `ai_model_settings`.

## Scope (MVP)
### Included
- Global floating assistant button and chat drawer in app shell.
- Backend route: `POST /api/chat-assistant`.
- Auth/session validation using current Supabase session.
- Workspace isolation check (`body.workspaceId` must match `profile.workspace_id`).
- Fixed credit charge per message: `0.1`.
- Workspace-scoped context retrieval from internal DB tables only.
- Assistant response generation with provider/model from `ai_model_settings` (`anthropic`, `gemini`, `mistral`, `xai`).
- Best-effort refund on generation failure after charge.

### Not Included (Post-MVP)
- Support KB crawling / RAG.
- Tool-calling or direct data mutation actions.
- Streaming response UI.
- Token-accurate dynamic billing.
- Long-term conversation persistence.

## Architecture
### Frontend
- Component: `src/components/chat-assistant-widget.tsx`
- Mounted from: `src/components/app-shell.tsx`
- Behavior:
  - Floating circular `AI` button.
  - Drawer panel with local message history.
  - Captures up to last 5 click events (label + route + target type).
  - Sends message payload to API route with idempotency header.

### Backend
- Route: `src/app/api/chat-assistant/route.ts`
- Runtime: Node.js (`export const runtime = "nodejs"`)
- Flow:
  1. Authenticate user.
  2. Validate request body schema.
  3. Resolve current profile via `get_current_profile`.
  4. Enforce workspace match.
  5. Deduct `0.1` credit via `deduct_workspace_credit` with idempotency key.
  6. Load workspace context from internal tables.
  7. Resolve active model for `chat_assistant` from `ai_model_settings`.
  8. Call selected provider API.
  9. Return assistant answer + updated balance.
  10. On generation failure, attempt `refund_workspace_credit`.

## Data Contracts
### Request
```json
{
  "workspaceId": "uuid",
  "routePath": "/contacts",
  "message": "Which contact needs attention?",
  "recentEvents": [
    {
      "at": "2026-08-05T10:10:10.000Z",
      "path": "/contacts",
      "targetType": "button",
      "label": "Open contact details"
    }
  ],
  "conversation": [
    { "role": "assistant", "content": "..." },
    { "role": "user", "content": "..." }
  ]
}
```

### Response (success)
```json
{
  "ok": true,
  "reply": "...",
  "creditsUsed": 0.1,
  "newBalance": 14.2
}
```

### Response (error)
```json
{
  "error": "Workspace mismatch"
}
```

## Security and Isolation
- The route requires authenticated Supabase user.
- `workspaceId` is rejected unless it equals current profile workspace.
- All context queries include `.eq("workspace_id", workspaceId)`.
- Context is limited to scoped fields from:
  - `crm_contacts`
  - `properties`
  - `workspace_documents`
- Assistant system prompt forbids using data outside provided context.

## Billing Rules (MVP)
- Fixed cost per user message: `0.1` credit.
- Deduction action key: `chat_assistant`.
- Idempotency enforced via `Idempotency-Key` header and RPC logic.
- On LLM failure after deduction, route issues a refund attempt.

## Config
Required env vars depend on selected provider in `ai_model_settings`:
- `ANTHROPIC_API_KEY` for `anthropic`
- `GEMINI_API_KEY` for `gemini`
- `MISTRAL_API_KEY` for `mistral`
- `XAI_API_KEY` for `xai`

Optional:
- `ANTHROPIC_API_BASE_URL` (default `https://api.anthropic.com/v1`)
- `GEMINI_API_BASE_URL` (default `https://generativelanguage.googleapis.com/v1beta`)
- `MISTRAL_API_BASE_URL` (default `https://api.mistral.ai/v1`)
- `XAI_API_BASE_URL` (default `https://api.x.ai/v1`)

## UX Notes
- Keep answers practical and short.
- Encourage in-app next steps and known route links.
- Surface balance after each successful message.

## Acceptance Criteria
1. The assistant button is visible across authenticated app screens.
2. Drawer opens/closes and sends messages.
3. Requests fail with `403` on workspace mismatch.
4. Each successful user message charges `0.1` credit.
5. Response uses internal workspace context and suggests relevant navigation.
6. On generation failure, refund is attempted.

## Next Steps After MVP
1. Add support intent routing and support KB retrieval.
2. Introduce token-based cost conversion to credits.
3. Add streaming responses and persisted conversation threads.
4. Add admin analytics for assistant usage and credit spend.
