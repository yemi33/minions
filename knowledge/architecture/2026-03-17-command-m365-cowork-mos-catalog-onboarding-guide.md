# M365 Cowork — MOS Catalog Onboarding Guide

How to register M365 Cowork (backed by OfficeAgent) in the MOS3 catalog so it appears in the M365 Copilot left rail, without any Sydney/TuringBot dependency.

---

## 1. Context

OfficeAgent runs on its own TypeScript/Node.js infrastructure (ISS repo), not on Sydney/TuringBot or MCS Aether. The standard MOS onboarding docs assume a Sydney Helix agent, but MOS doesn't require Sydney. Production agents that prove this:

| Agent | Backend | MOS Type | Custom Experience |
|-------|---------|----------|-------------------|
| Cowork Weave | MCS Aether Runtime | DeclarativeCopilot | Weave |
| DeepWork | Sydney (but with custom UX) | DeclarativeCopilot | Deepwork |
| Workflows | Sydney (but with custom UX) | DeclarativeCopilot | Workflows |
| M365 Cowork | OfficeAgent (ISS) | DeclarativeCopilot | M365Cowork |

All four follow the same pattern: upload a UAP to MOS, declare a `customExperience`, and the client loads a federated UX module instead of default chat.

---

## 2. What You Need

| Artifact | Purpose | Who Creates |
|----------|---------|-------------|
| Unified Application Package (UAP) | .zip containing manifest + icons, uploaded to MOS | William Li <liwilliam@microsoft.com> |
| TitleId | Assigned by MOS on upload, identifies your agent globally | MOS (automatic) |
| Custom Experience client handler | 1JS/midgard code that loads your UX when the client sees "M365Cowork" | 1JS team (partnership) William Li <liwilliam@microsoft.com> |
| Federated UX module | Skill picker + chat UI served from CDN | William Li <liwilliam@microsoft.com> |
| OfficeAgent backend | Pages skills + LWS integration | Sachin Rao (Office) <sacra@microsoft.com> |

---

## 3. Step-by-Step Onboarding

### Step 1: Create the Unified Application Package

The UAP is a `.zip` with these files:

```
appPackage/
├── manifest.json          ← Unified Application Manifest
├── declarativeAgent.json  ← Declarative Agent Manifest
├── color.png              ← 192x192 color icon
└── outline.png            ← 32x32 outline icon
```

**manifest.json**
```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17",
  "version": "1.0.0",
  "id": "YOUR-APP-GUID-HERE",
  "developer": {
    "name": "Microsoft Corporation",
    "websiteUrl": "https://www.microsoft.com",
    "privacyUrl": "https://privacy.microsoft.com",
    "termsOfUseUrl": "https://www.microsoft.com/servicesagreement"
  },
  "name": {
    "short": "M365 Cowork",
    "full": "M365 Cowork — Rich Content Pages"
  },
  "description": {
    "short": "Create reports, webpages, briefs, trackers, and newsletters as Copilot Pages",
    "full": "A document creation agent that generates structured, shareable Copilot Pages from natural language. Supports reports, webpages, executive briefs, project trackers, and newsletters with full HTML rendering."
  },
  "icons": {
    "color": "color.png",
    "outline": "outline.png"
  },
  "accentColor": "#0078D4",
  "copilotAgents": {
    "declarativeAgents": [
      {
        "$ref": "declarativeAgent.json"
      }
    ]
  }
}
```

**declarativeAgent.json**
```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/copilot/declarative-agent/v1.4/schema.json",
  "version": "v1.4",
  "id": "m365Cowork",
  "name": "M365 Cowork",
  "description": "Create rich content pages — reports, webpages, briefs, trackers, newsletters",
  "instructions": "You are a document creation agent that generates structured Copilot Pages using the Loop Web Service.",
  "conversation_starters": [
    { "title": "Create a report", "text": "Create a weekly status report for my project" },
    { "title": "Create a webpage", "text": "Build a project portal page for my team" },
    { "title": "Create a brief", "text": "Write an executive summary of this quarter's results" },
    { "title": "Create a tracker", "text": "Set up an OKR tracking page for Q2" }
  ],
  "behavior_overrides": {
    "x-custom_experience": {
      "name": "M365Cowork"
    }
  },
  "x-experimental_capabilities": [
    { "name": "CustomExperience" }
  ]
}
```

**Key fields:**

| Field | Value | Why |
|-------|-------|-----|
| `id` | `m365Cowork` | Package-relative agent ID; combined with TitleId to form the full GPT ID |
| `x-custom_experience.name` | `M365Cowork` | The client matches this string to load your federated UX |
| `x-experimental_capabilities` | `CustomExperience` | Tells `/getGptList` to add `CustomExperience` to `requiredClientFeatures`, hiding the agent on unsupported clients |
| `conversation_starters` | Array of suggestions | Shown in the agent's homepage before the user types |
| `instructions` | Minimal | Real instructions live in OfficeAgent's SKILL.md files, not the manifest |

### Step 2: Register in Nexus Portal

1. Navigate to the Nexus Portal: https://aka.ms/copilot/devx/onboarding
2. Create a new agent entry
3. Fill in metadata (name, description, owner, ICM team)
4. Click **Generate MOS Config** to auto-generate the UAP — or use the manually crafted UAP from Step 1

### Step 3: Upload to MOS Catalog

1. In the Nexus Portal, click **Upload MOS Config**
2. Upload `appPackage/build/appPackage.dev.zip`
3. MOS validates the manifest and queues the agent for indexing
4. MOS sends a shoulder tap to Substrate Search Assistants (SSA)
5. SSA rebuilds the user app index — agent is discoverable immediately

### Step 4: Receive TitleId

MOS assigns a TitleId on successful upload:
```
T_<guid>
Example: T_a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

The full GPT ID becomes:
```
T_a1b2c3d4-e5f6-7890-abcd-ef1234567890.m365Cowork
```

You do **NOT** need to add this to Sydney's `AgentTitleIdConfig.ini` because:
- That file maps TitleIds to Sydney agent names for Sydney's internal routing
- Your agent runs on OfficeAgent, not Sydney
- Sydney's `MetaOsGptProvider` returns your agent metadata to the client via `/getGptList` without needing to know how to route it internally

### Step 5: Register Custom Experience in 1JS Client

This requires a partnership with the 1JS/midgard team. The M365 Chat client needs code that says: "When I see `customExperience.name = 'M365Cowork'`, load this UX module."

Following the Cowork Weave pattern, you need a midgard package:

```
midgard/packages/m365-cowork/
├── src/
│   ├── M365CoworkExperience.tsx   ← Federation shell
│   ├── SkillPicker.tsx            ← Renders skills.json cards
│   └── constants.ts               ← CDN URL, version
├── package.json
└── tsconfig.json
```

The federation shell loads your UX from a CDN:
```tsx
export const M365CoworkExperience: React.FC<Props> = ({
  cdnUrl, version, userId, tenantId, theme, tokenProviders
}) => {
  useEffect(() => {
    initializeFederation({ cdnUrl, version });
  }, [cdnUrl, version]);

  return <FederatedM365Cowork {...props} />;
};
```

### Step 6: Deploy Federated UX to CDN

Your skill picker UI and chat experience are served from Azure Front Door (same pattern as Cowork Weave):

```
https://officeagentpages-<hash>.azurefd.net/latest/static/js/async/
├── skill-picker.{hash}.js        ← Skill cards UI
├── chat-view.{hash}.js           ← Active conversation renderer
├── page-preview.{hash}.js        ← Inline Copilot Page preview
└── shared-chunk.{hash}.js        ← Common utilities
```

CDN URL and version are overridable via ECS feature flags for independent deployment.

### Step 7: Wire Client to OfficeAgent Backend

The federated UX connects to OfficeAgent via WebSocket (not to Sydney or Aether):

```
Client (CDN bundles)
    │
    ├── WebSocket connect → OfficeAgent endpoint
    ├── Send: { message: "[skill:create-report] ...", role: "user" }
    ├── Receive: streaming agent responses
    └── Receive: { pageLink: "https://loop.cloud.microsoft/p/..." }
```

### Step 8: Ring Progression

Ring progression is controlled in three independent layers:

| Layer | Mechanism | How to Configure |
|-------|-----------|-----------------|
| MOS catalog | Security groups | Nexus Portal → Ring Settings → Add SG per ring |
| Client UX | ECS feature flags | `featureFlags.m365CoworkCdnUrl`, `featureFlags.m365CoworkVersion` |
| OfficeAgent backend | Docker deployment | ISS deployment pipeline |

Ring order: `SDF-Pilot → SDF-Master → MSIT-Pilot → MSIT-Master → WW-Pilot → WW → GCC → DOD`

---

## 4. What Happens at Runtime

```
1. User opens M365 Copilot
       │
       ▼
2. Client calls /getGptList API
       │
       ▼
3. Sydney's MetaOsGptProvider queries Entity Serve
   Entity Serve returns agents from user's index, including:
   {
     "gptId": "T_<guid>.m365Cowork",
     "source": "MOS3",
     "type": "DeclarativeCopilot",
     "customExperience": { "name": "M365Cowork" },
     "requiredClientFeatures": ["CustomExperience"]
   }
       │
       ▼
4. Client checks: do I support "CustomExperience"?
   ├── No  → Agent hidden (old clients)
   └── Yes → Read customExperience.name
       │
       ▼
5. Client matches "M365Cowork" → loads federated UX from CDN
       │
       ▼
6. UX reads skills.json → renders skill picker
       │
       ▼
7. User picks skill + types prompt → sent to OfficeAgent (NOT Sydney)
       │
       ▼
8. OfficeAgent processes → creates Copilot Page via LWS
       │
       ▼
9. Returns page link → UX shows inline preview + "Open" button
```

Sydney's role is purely passthrough — it returns your agent's metadata from Entity Serve to the client. It never processes your requests.

---

## 5. What You Do NOT Need in Sydney

| Sydney Artifact | Required for Helix Agents | Required for You |
|-----------------|--------------------------|-----------------|
| `AgentTitleIdConfig.ini` entry | Yes | No — your backend is OfficeAgent |
| `CompliantAgentName.bond` enum | Yes | No |
| `OwnershipServiceTeam.bond` enum | Yes | No |
| `BuiltInAgents/{Name}/latest.json` | Yes | No |
| `AgentRuntime/Agents/{Name}/releases/` | Yes | No |
| `bizchat_enable{Name}.json` flight | Yes | No |
| Any C# code in Sydney | Yes | No |

The only Sydney-related system you interact with is the `/getGptList` API, and that happens automatically — `MetaOsGptProvider` queries Entity Serve which includes all MOS3 agents.

---

## 6. Comparison: How Others Did It

### Cowork Weave (closest precedent)

| Step | What Weave Did | What You Do |
|------|---------------|-------------|
| UAP | Created with `customExperience.name = "Weave"` | Same, with `"M365Cowork"` |
| MOS upload | Via Nexus Portal | Same |
| TitleId | `T_7e151bfa-7eaa-0802-049f-5d3b98c95e04` | You'll get your own |
| Sydney changes | None | None |
| Client package | `mcs-coworker` (federation shell) | Your equivalent package |
| CDN | `coworker-*.azurefd.net` | Your CDN |
| Backend | MCS Aether Runtime (`/v1/skills`, `/v1/messages`, SSE) | OfficeAgent (WebSocket, SDK tools) |
| Backend API | Aether REST + SSE | OfficeAgent WebSocket |

### DeepWork (Sydney-backed but custom UX)

| Step | What DeepWork Did | Difference for You |
|------|------------------|-------------------|
| UAP | `customExperience.name = "Deepwork"` | Same pattern |
| Manifest location | `Config/Manifests/DeepWork/gpt.json` (in Sydney repo) | Your manifest is in the UAP, not in Sydney |
| Backend | Sydney with Helix runtime | OfficeAgent (no Sydney) |
| Required client features | `FluxV3`, `ChainOfThoughtExperience` | `CustomExperience` |

---

## 7. Development & Testing

### Local Development (Before MOS Registration)

```bash
# 1. Run OfficeAgent locally
docker-compose up

# 2. Point your UX dev server to localhost
OFFICEAGENT_ENDPOINT=ws://localhost:3000

# 3. Test skill picker → OfficeAgent → LWS flow end-to-end
```

### Sideloading (Dev Ring Testing)

```bash
# Package the UAP
cd appPackage && zip -r appPackage.dev.zip manifest.json declarativeAgent.json color.png outline.png

# Sideload to your M365 tenant
teamsapp install --file-path appPackage.dev.zip
```

**Caveats:**
- Sideloaded apps don't trigger SSA shoulder tap — may take up to 24 hours to appear
- `x-` experimental properties may be stripped during MOS ↔ Teams catalog 24-hour sync
- Fine for dev/test, not for production

### Integration Testing with M365 Copilot

1. Open M365 Copilot (m365.cloud.microsoft)
2. Check left rail — your agent should appear (after indexing)
3. Click agent → should load your federated UX (skill picker)
4. Pick a skill → message should reach OfficeAgent
5. Verify Copilot Page is created and link returned

---

## 8. Indexing & Propagation Timing

| Event | Latency |
|-------|---------|
| Upload via Nexus Portal | Immediate — MOS sends shoulder tap to SSA |
| Sideload via Teams App CLI | Up to 24 hours — no shoulder tap |
| Manifest version bump (re-upload) | Immediate if via Nexus Portal |
| `x-` experimental properties | Preserved on direct upload; stripped during 24-hour MOS ↔ Teams catalog sync |
| User index rebuild | Once per 24 hours (scheduled) or on shoulder tap (immediate) |

---

## 9. Auth & Permissions

| Requirement | Details |
|-------------|---------|
| Azure AD tenant | Must be a Microsoft corporate tenant |
| Nexus Portal access | Request via https://aka.ms/copilot/devx/onboarding |
| Teams Admin role | Required for publishing to tenant catalog (not for sideloading) |

---

## 10. Contacts & Resources

| Resource | Link / Contact |
|----------|---------------|
| 1P Agent Onboarding | https://aka.ms/copilot/devx/onboarding |
| DA++ Wiki | https://aka.ms/da/wiki |
| MOS/Nexus Platform Owner | prateekarora@microsoft.com |
| Nexus ICM Team | M365 Copilot Nexus Platform |
| Custom Experience Contract Doc | `sydney/docs/.../Required-Features-Contract.md` |
| DA++ Teams Channel | "Copilot 1st party agents UX (DAPlusPlus)" |
| Teams App CLI | https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/teams-toolkit-cli |

---

## 11. Checklist

- [ ] 1. Create UAP (`manifest.json` + `declarativeAgent.json` + icons)
- [ ] 2. Generate app GUID for `manifest.id`
- [ ] 3. Register agent in Nexus Portal
- [ ] 4. Upload UAP to MOS via Nexus Portal
- [ ] 5. Receive TitleId from MOS
- [ ] 6. Partner with 1JS/midgard team to register `"M365Cowork"` custom experience
- [ ] 7. Build federated UX module (skill picker + chat view + page preview)
- [ ] 8. Deploy UX to Azure Front Door CDN
- [ ] 9. Deploy OfficeAgent with Pages skills + LWS tools
- [ ] 10. Wire federated UX → OfficeAgent WebSocket endpoint
- [ ] 11. Test sideloaded in SDF ring
- [ ] 12. Formal MOS ring progression (SDF → MSIT → WW)
- [ ] 13. Set up ECS feature flags for CDN URL/version override
- [ ] 14. Set up MOS security groups per ring
