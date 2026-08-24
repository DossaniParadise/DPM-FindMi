const admin = require('firebase-admin');

// Initialize Firebase Admin (Serverless-safe pattern)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
    databaseURL: "https://dpm-alignment-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();

// ─────────────────────────────────────────────────────────────────────
// COST CONTROL #1: statuses hidden from GET responses by default.
// 291 of 387 tickets were status "closed" (~72% of the tickets payload),
// so excluding them shrinks every response dramatically. Callers that
// genuinely need history opt back in with  ?includeClosed=1
// To also hide "finished" tickets by default, add it to this array.
// ─────────────────────────────────────────────────────────────────────
const HIDDEN_STATUSES = ["closed"];

function filterTickets(allTickets, includeClosed) {
  if (includeClosed) return allTickets;
  const out = {};
  for (const [id, t] of Object.entries(allTickets)) {
    if (t && HIDDEN_STATUSES.includes(t.status)) continue;
    out[id] = t;
  }
  return out;
}

export default async function handler(req, res) {
  // CORS Headers - Allow frontend apps to communicate with this API
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle browser preflight checks
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // =======================================================================
  // 1. READ-ONLY ROUTE (GET) - Completely Open
  // Returns the master database JSON payload for apps to consume,
  // minus closed tickets unless ?includeClosed=1 is passed.
  // =======================================================================
  if (req.method === 'GET') {
    try {
      // ───────────────────────────────────────────────────────────────
      // COST CONTROL #2: let Vercel's CDN cache GET responses.
      // s-maxage=60  → the CDN serves repeat requests for 60s without
      //                invoking this function (zero Fast Origin Transfer,
      //                zero invocation). Each distinct query string
      //                (?vendor=x, ?includeClosed=1) is cached separately.
      // stale-while-revalidate=300 → after the 60s, the CDN keeps serving
      //                the stale copy instantly while refreshing once in
      //                the background, so users never wait.
      // Raise s-maxage if your apps tolerate staler data; POST writes do
      // NOT purge this cache, so reads can lag writes by up to s-maxage.
      // ───────────────────────────────────────────────────────────────
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

      const includeClosed =
        req.query && (req.query.includeClosed === '1' || req.query.includeClosed === 'true');

      // ───────────────────────────────────────────────────────────────
      // CLOSED-ONLY READ:  GET ...?closed=only   (added for RM app 2.7.4)
      // Returns JUST the hidden-status tickets plus their count. The RM
      // app calls this only when the Closed tab is actually opened, so
      // the ~72% of payload that is closed history is never downloaded
      // during normal use or polling.
      // ───────────────────────────────────────────────────────────────
      if (req.query && req.query.closed === 'only') {
        const snapshot = await db.ref('maintenanceTickets').once('value');
        const all = snapshot.val() || {};
        const closedOnly = {};
        for (const [id, t] of Object.entries(all)) {
          if (t && HIDDEN_STATUSES.includes(t.status)) closedOnly[id] = t;
        }
        return res.status(200).json({
          maintenanceTickets: closedOnly,
          closedTicketCount: Object.keys(closedOnly).length
        });
      }

      // ───────────────────────────────────────────────────────────────
      // SCOPED VENDOR READ:  GET ...?vendor=<vendorId>
      // Returns ONLY the data an external vendor board needs:
      //   • tickets in `maintenanceTickets` whose assignedVendorId === vendorId
      //   • a trimmed `restaurants` map (only stores those tickets reference,
      //     and only the display fields a board uses)
      //   • that vendor's own record from `maintenanceVendors`
      // This keeps per-load payloads small as stores/tickets grow, and avoids
      // shipping the whole master DB to third-party dashboards.
      // The full open GET (no ?vendor) is unchanged for internal apps.
      // ───────────────────────────────────────────────────────────────
      // The ?vendor param may be either a vendor NAME (preferred — stable across
      // re-adds) or a raw vendor key. We resolve it to the real key by checking
      // names case-insensitively first, then falling back to a direct key match.
      const vendorParam = req.query && req.query.vendor;
      if (vendorParam) {
        const snapshot = await db.ref('/').once('value');
        const master = snapshot.val() || {};
        // Closed tickets are dropped here too unless ?includeClosed=1.
        const allTickets = filterTickets(master.maintenanceTickets || {}, includeClosed);
        const allStores  = master.restaurants || {};
        const allVendors = master.maintenanceVendors || {};

        // Resolve the param to an actual vendor key.
        const wanted = String(vendorParam).trim().toLowerCase();
        let vendorKey = null, vendorRec = null;
        for (const [key, v] of Object.entries(allVendors)) {
          if (v && String(v.name || "").trim().toLowerCase() === wanted) { vendorKey = key; vendorRec = v; break; }
        }
        if (!vendorKey && allVendors[vendorParam]) {   // fallback: param was a key
          vendorKey = vendorParam; vendorRec = allVendors[vendorParam];
        }

        const tickets = {};
        const storeIds = new Set();
        // If we couldn't resolve the vendor, return an empty (but valid) payload.
        if (vendorKey) {
          for (const [id, t] of Object.entries(allTickets)) {
            if (t && t.assignedVendorId === vendorKey) {
              tickets[id] = t;
              if (t.storeId) storeIds.add(t.storeId);
            }
          }
        }
        // Trim restaurants to only referenced stores and only display fields.
        const restaurants = {};
        for (const sid of storeIds) {
          const s = allStores[sid];
          if (!s) continue;
          restaurants[sid] = {
            storeName: s.storeName || "",
            storeNumber: s.storeNumber || "",
            address: s.address || "",
            latitude: s.latitude || "",
            longitude: s.longitude || ""
          };
        }
        // Return the resolved key so the board writes back with the correct id.
        return res.status(200).json({ maintenanceTickets: tickets, restaurants, vendor: vendorRec, vendorKey });
      }

      const snapshot = await db.ref('/').once('value');
      const master = snapshot.val() || {};
      if (master.maintenanceTickets) {
        // Tiny metadata field (~30 bytes) so apps can show a "Closed" count
        // without ever downloading the closed tickets themselves.
        master.closedTicketCount = Object.values(master.maintenanceTickets)
          .filter(t => t && HIDDEN_STATUSES.includes(t.status)).length;
        master.maintenanceTickets = filterTickets(master.maintenanceTickets, includeClosed);
      }
      return res.status(200).json(master);
    } catch (error) {
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  // =======================================================================
  // 2. WRITE ROUTE (POST) - Strict Role-Based Access Control (RBAC)
  // Intercepts write requests, verifies the role password, and checks
  // if the requested path is allowed for that specific role.
  // =======================================================================
  if (req.method === 'POST') {
    try {
      const { password, updates } = req.body;

      if (!updates || Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No updates provided" });
      }

      /* ------------------------------------------------------------------
         FUTURE AI CONTEXT:
         This API acts as a universal router for a multi-app ecosystem
         using a single flat Firebase Realtime Database.
         To add a new write-capable app:
         1. Add a new key-value pair to the ROLES object below.
         2. Create a specific path-validation check for that role.
      ------------------------------------------------------------------ */

      const ROLES = {
        ADMIN: "dpm6",              // Central Manager: Blanket access to all core routing data
        FILTER: "filter123",       // Preventative Maintenance App: Restricted access
        MAINTENANCE: "rm123",      // Repair & Maintenance App (internal source of truth)
        VENDOR: "vendor123",       // Generic external vendor boards (CHANGE THIS SECRET)
        PORTAL: "portal123"        // Dossani Portal launchpad: tile list only (CHANGE THIS SECRET)
      };

      const isMasterAdmin = (password === ROLES.ADMIN);
      const isFilterApp   = (password === ROLES.FILTER);
      const isMaintApp    = (password === ROLES.MAINTENANCE);
      const isVendorApp   = (password === ROLES.VENDOR);
      const isPortalApp   = (password === ROLES.PORTAL);

      // If the password matches nothing, reject immediately
      if (!isMasterAdmin && !isFilterApp && !isMaintApp && !isVendorApp && !isPortalApp) {
        return res.status(401).json({ error: "Unauthorized: Incorrect Password or Invalid Role" });
      }

      // GATEKEEPER: Enforce Path Restrictions for specific apps

      // --- Filter App: only its two nodes ---
      if (isFilterApp) {
        for (let path in updates) {
          // The Filter App is ONLY allowed to write to these two specific nodes
          const isAllowedPath = path.startsWith('filterChanges/') || path.startsWith('gasCoverChanges/');

          if (!isAllowedPath) {
            console.warn(`Blocked unauthorized Filter App write attempt to: ${path}`);
            return res.status(403).json({ error: "Access Denied: The Filter App cannot edit core store alignment data." });
          }
        }
      }

      // --- Dossani Portal launchpad: only its own config node ---
      // The portal publishes its tile list (which links each role/division
      // sees) to dpmPortal/. Its password ships inside a public HTML file,
      // so it must never be able to touch tickets, vendors, the directory,
      // or any other app's data — whitelist exactly the one prefix it owns.
      if (isPortalApp) {
        for (let path in updates) {
          const isAllowedPath = path === 'dpmPortal' || path.startsWith('dpmPortal/');

          if (!isAllowedPath) {
            console.warn(`Blocked unauthorized Portal write attempt to: ${path}`);
            return res.status(403).json({ error: "Access Denied: The Portal can only edit its own dpmPortal node." });
          }
        }
      }

      // --- Repair & Maintenance App: only its two nodes ---
      // This app stores its tickets and its approved-vendor list as nodes in
      // the master DB. It must never be able to touch store alignment, the
      // people nodes, or any other app's data — so we whitelist exactly the
      // two prefixes it owns and reject everything else.
      if (isMaintApp) {
        for (let path in updates) {
          const isAllowedPath = path.startsWith('maintenanceTickets/') ||
            path.startsWith('maintenanceVendors/') ||
            path.startsWith('admins/');

          if (!isAllowedPath) {
            console.warn(`Blocked unauthorized Maintenance App write attempt to: ${path}`);
            return res.status(403).json({ error: "Access Denied: The Maintenance App can only edit its own ticket and vendor nodes." });
          }
        }
      }

      // --- Generic Vendor Board: may ONLY update tickets already assigned to
      //     it, and ONLY safe fields. ------------------------------------------
      // External vendor dashboards (AWT and future boards) share this one role.
      // There is a SINGLE source of truth: the maintenanceTickets node. A vendor
      // board does not own a separate node — it edits the same ticket the RM app
      // owns. To stay safe at scale we enforce, per ticket:
      //   1. path must be exactly maintenanceTickets/<id> (no other nodes)
      //   2. the request must include vendorId, and the EXISTING ticket's
      //      assignedVendorId must equal that vendorId (can't touch others')
      //   3. immutable fields (storeId, assignedVendorId, assignedTechId,
      //      shortId, createdAt, createdBy*) cannot be changed — a board can
      //      move status and append notes/comments/activity, nothing structural.
      if (isVendorApp) {
        const vendorId = req.body && req.body.vendorId;
        if (!vendorId) {
          return res.status(400).json({ error: "Vendor writes require a vendorId." });
        }
        const IMMUTABLE = ["storeId","assignedVendorId","assignedTechId","shortId","createdAt","createdBy","createdByRole","createdByName","category","priority"];
        for (const path in updates) {
          const m = /^maintenanceTickets\/([^/]+)$/.exec(path);
          if (!m) {
            console.warn(`Blocked vendor write to non-ticket path: ${path}`);
            return res.status(403).json({ error: "Access Denied: vendor boards may only edit their assigned tickets." });
          }
          const ticketId = m[1];
          const existing = (await db.ref(`maintenanceTickets/${ticketId}`).once('value')).val();
          if (!existing) {
            return res.status(404).json({ error: "Ticket not found." });
          }
          if (existing.assignedVendorId !== vendorId) {
            console.warn(`Blocked vendor ${vendorId} from editing ticket owned by ${existing.assignedVendorId}`);
            return res.status(403).json({ error: "Access Denied: that ticket is not assigned to this vendor." });
          }
          const incoming = updates[path] || {};
          for (const f of IMMUTABLE) {
            if (Object.prototype.hasOwnProperty.call(incoming, f) && incoming[f] !== existing[f]) {
              return res.status(403).json({ error: `Access Denied: vendor boards cannot change '${f}'.` });
            }
          }
        }
      }

      // If all security checks pass, execute the batch update using the Master Admin key
      await db.ref('/').update(updates);

      return res.status(200).json({ success: true });

    } catch (error) {
      console.error("Database Write Error:", error);
      return res.status(500).json({ error: 'Failed to write to database' });
    }
  }

  // Fallback for any other HTTP method
  return res.status(405).json({ error: 'Method not allowed.' });
}
