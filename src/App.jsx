import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import {
  addDoc, collection, deleteDoc, doc, getDoc, limit, onSnapshot,
  orderBy, query, setDoc, updateDoc, where,
} from "firebase/firestore";
import { auth, db, provider } from "./firebase";

const PILOT = "Maharashtra";
const CITIES = ["Ahilyanagar","Akola","Amravati","Bhiwandi","Chandrapur","Chhatrapati Sambhajinagar","Dhule",
  "Jalgaon","Kolhapur","Latur","Mumbai","Nagpur","Nanded","Nashik","Navi Mumbai","Panvel","Pimpri-Chinchwad",
  "Pune","Ratnagiri","Sangli","Satara","Solapur","Thane","Wardha","Yavatmal"];
const VEHICLES = ["Pickup (Tata Ace / Bolero)","Mini truck (407 / 14ft)","Loader truck","Trailer"];

const digits = (v, n) => v.replace(/\D/g, "").slice(0, n);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const endOfDay = (str) => new Date(str + "T23:59:59").getTime();
const fmtDate = (str) => new Date(str + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const dateLabel = (l) => !l.departDate ? (l.date || "Date flexible")
  : (l.role === "truck" && l.arriveDate ? `Departs ${fmtDate(l.departDate)} · Arrives ${fmtDate(l.arriveDate)}` : `Pickup ${fmtDate(l.departDate)}`);
// A listing is visible only while it is open and its date has not passed.
const isActive = (l) => (l.status || "open") === "open" && !(l.expiresAt && l.expiresAt < Date.now());
const bySoonest = (a, b) => (a.expiresAt || 9e15) - (b.expiresAt || 9e15);
const genCode = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return "KS-" + String(a[0] % 1000000).padStart(6, "0"); };

// Shrinks a phone photo to ~100-200 KB so it fits in a Firestore document (no paid Storage needed).
function compress(file, max = 900, q = 0.6) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL("image/jpeg", q));
    };
    img.onerror = () => rej(new Error("Could not read that image."));
    img.src = url;
  });
}

export default function App() {
  const [user, setUser] = useState(undefined);
  const [profile, setProfile] = useState(undefined);
  const [kyc, setKyc] = useState(undefined);
  const [isAdmin, setIsAdmin] = useState(false);
  const [listings, setListings] = useState([]);
  const [threads, setThreads] = useState([]);
  const [tab, setTab] = useState("find");
  const [postRole, setPostRole] = useState("load");
  const [chat, setChat] = useState(null);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => onAuthStateChanged(auth, (u) => {
    setUser(u);
    if (!u) { setProfile(null); setKyc(null); setIsAdmin(false); setTab("find"); }
  }), []);

  useEffect(() => {
    if (!user) return;
    const u1 = onSnapshot(doc(db, "users", user.uid), (s) => setProfile(s.exists() ? s.data() : null), (e) => setErr(e.message));
    const u2 = onSnapshot(doc(db, "kyc", user.uid), (s) => setKyc(s.exists() ? s.data() : null), () => setKyc(null));
    getDoc(doc(db, "admins", user.uid)).then((s) => setIsAdmin(s.exists())).catch(() => setIsAdmin(false));
    return () => { u1(); u2(); };
  }, [user]);

  useEffect(() => onSnapshot(
    query(collection(db, "listings"), orderBy("createdAt", "desc"), limit(300)),
    (s) => setListings(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => setErr(e.message)), []);

  useEffect(() => {
    if (!user) { setThreads([]); return; }
    return onSnapshot(
      query(collection(db, "threads"), where("participants", "array-contains", user.uid)),
      (s) => setThreads(s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))),
      (e) => setErr(e.message));
  }, [user]);

  // Housekeeping: each user's own expired listings are deleted automatically when they open the app.
  useEffect(() => {
    if (!user) return;
    const now = Date.now();
    listings.filter((l) => l.ownerId === user.uid && l.expiresAt && l.expiresAt < now)
      .forEach((l) => deleteDoc(doc(db, "listings", l.id)).catch(() => {}));
  }, [listings, user]);

  // Keeps my own listings in step with my deals, so it works even if the other person's app didn't manage it.
  useEffect(() => {
    if (!user) return;
    threads.forEach((t) => {
      const ids = t.toClose && t.toClose.length ? t.toClose : (t.listingId ? [t.listingId] : []);
      ids.forEach((id) => {
        const l = listings.find((x) => x.id === id);
        if (!l || l.ownerId !== user.uid) return;
        const ref = doc(db, "listings", id);
        if (["confirmed", "picked_up"].includes(t.dealStatus) && (l.status || "open") === "open")
          updateDoc(ref, { status: "booked", bookedThread: t.id }).catch(() => {});
        else if (t.dealStatus === "delivered") deleteDoc(ref).catch(() => {});
        else if (t.dealStatus === "cancelled" && l.status === "booked" && l.bookedThread === t.id && !(l.expiresAt && l.expiresAt < Date.now()))
          updateDoc(ref, { status: "open", bookedThread: t.id }).catch(() => {});
      });
    });
  }, [threads, listings, user]);

  const login = () => signInWithPopup(auth, provider).catch((e) => setErr(e.message));

  async function openChat(l) {
    if (!user) return login();
    if (!profile) { setEditing(true); return; }
    // Offering on or chatting about a LOAD is for verified drivers only.
    if (l.role === "load" && kyc?.status !== "verified") {
      if (kyc?.status === "pending") alert("Your driver verification is under review. You can offer on loads once it is approved.");
      else { alert("Only verified drivers can chat or make offers on loads. Opening verification…"); setPostRole("truck"); setTab("post"); }
      return;
    }
    const tid = `${l.id}_${[user.uid, l.ownerId].sort().join("_")}`;
    const ref = doc(db, "threads", tid);
    try {
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        const truck = l.role === "truck";
        await setDoc(ref, {
          participants: [user.uid, l.ownerId],
          names: { [user.uid]: profile.name, [l.ownerId]: l.ownerName },
          driverId: truck ? l.ownerId : user.uid,
          shipperId: truck ? user.uid : l.ownerId,
          listingRoute: `${l.from} → ${l.to}`, listingDetail: l.detail,
          listingId: l.id, toClose: [], dealStatus: "none", lastMessage: "", updatedAt: Date.now(),
        });
      }
      setChat({ id: tid, title: `${l.from} → ${l.to}`, sub: l.detail });
    } catch (e) { setErr(e.message); }
  }

  if (user === undefined || (user && profile === undefined)) return <div className="center">Loading…</div>;
  const needProfile = user && (profile === null || editing);

  return (
    <>
      <header>
        <div className="brand">Khali<span>Space</span></div>
        <div className="head-right">
          <span className="dim">{PILOT} pilot</span>
          {user && <button className="link" onClick={() => signOut(auth)}>Sign out</button>}
        </div>
      </header>
      <main>
        {err && <div className="note err" onClick={() => setErr("")}>{err} (tap to dismiss)</div>}

        {!user && (
          <div className="card hero">
            <h1>Send big loads with trucks already on the road.</h1>
            <p className="dim">Find a truck on your route, or list spare space on a trip you’re already driving. Chat inside the app, confirm the deal, get a booking code.</p>
            <button className="primary" onClick={login}>Sign in with Google</button>
          </div>
        )}

        {needProfile ? (
          <ProfileForm user={user} profile={profile} onDone={() => setEditing(false)} setErr={setErr} />
        ) : (
          <>
            <div className="navtabs">
              <button className={tab === "find" ? "on" : ""} onClick={() => setTab("find")}>Find</button>
              {user && <button className={tab === "post" ? "on" : ""} onClick={() => setTab("post")}>Post</button>}
              {user && <button className={tab === "messages" ? "on" : ""} onClick={() => setTab("messages")}>Messages</button>}
              {isAdmin && <button className={tab === "admin" ? "on" : ""} onClick={() => setTab("admin")}>Admin</button>}
            </div>

            {tab === "find" && <Find listings={listings} user={user} verified={kyc?.status === "verified"} onMessage={openChat} />}
            {tab === "post" && user && profile && (
              <PostTab user={user} profile={profile} kyc={kyc} listings={listings} role={postRole} setRole={setPostRole}
                onEditProfile={() => setEditing(true)} setErr={setErr} />
            )}
            {tab === "messages" && user && (
              <MessagesTab threads={threads} user={user} onOpen={(t) => setChat({ id: t.id, title: t.listingRoute, sub: t.listingDetail })} />
            )}
            {tab === "admin" && isAdmin && <AdminPanel setErr={setErr} />}
          </>
        )}
      </main>
      <footer>KhaliSpace {PILOT} pilot · Chat here, then agree the meeting point, price and pickup directly.</footer>
      {chat && <ChatPanel user={user} chat={chat} listings={listings} onClose={() => setChat(null)} setErr={setErr} />}
    </>
  );
}

function MessagesTab({ threads, user, onOpen }) {
  const [extra, setExtra] = useState(0);
  const ACTIVE = ["proposed", "confirmed", "picked_up"];
  const current = threads.filter((t) => ACTIVE.includes(t.dealStatus));
  const rest = threads.filter((t) => !ACTIVE.includes(t.dealStatus));
  const shown = rest.slice(0, 2 + extra);
  const row = (t) => {
    const other = t.participants.find((p) => p !== user.uid);
    return (
      <div key={t.id} className="thread" onClick={() => onOpen(t)}>
        <div className="row">
          <div className="route">{t.listingRoute}</div>
          {t.dealStatus && t.dealStatus !== "none" && <span className="badge">{t.dealStatus.replace("_", " ")}</span>}
        </div>
        <div className="dim small">{(t.names && t.names[other]) || "Someone"}: {t.lastMessage || "No messages yet"}</div>
      </div>
    );
  };
  return (
    <div>
      {threads.length === 0 && <div className="empty">No conversations yet — message someone from a listing.</div>}
      {current.length > 0 && <><h3 style={{ marginTop: 0 }}>Current orders</h3>{current.map(row)}</>}
      {rest.length > 0 && <><h3>Recent chats</h3>{shown.map(row)}</>}
      {rest.length > shown.length && <button className="ghost" onClick={() => setExtra(extra + 5)}>Load older chats ({rest.length - shown.length})</button>}
    </div>
  );
}

function ProfileForm({ user, profile, onDone, setErr }) {
  const [name, setName] = useState(profile?.name || user.displayName || "");
  const [phone, setPhone] = useState(profile?.phone || "");
  async function save(e) {
    e.preventDefault();
    if (!name.trim() || phone.length !== 10) { alert("Enter your name and a 10-digit phone number."); return; }
    try { await setDoc(doc(db, "users", user.uid), { name: name.trim(), phone }); onDone(); }
    catch (e2) { setErr(e2.message); }
  }
  return (
    <form className="card" onSubmit={save}>
      <h2>Your profile</h2>
      <p className="dim small">Your phone number is private — never shown on listings.</p>
      <div className="grid2">
        <div><label>Your name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label>Phone (10 digits)</label><input inputMode="numeric" value={phone} onChange={(e) => setPhone(digits(e.target.value, 10))} /></div>
      </div>
      <button className="primary" type="submit">Save profile</button>
    </form>
  );
}

/* ---------------- FIND: browse by location, not one endless page ---------------- */
function Find({ listings, user, verified, onMessage }) {
  const [f, setF] = useState({ from: "", to: "", role: "" });
  const [all, setAll] = useState(false);
  const [shown, setShown] = useState(8);
  const active = listings.filter(isActive).sort(bySoonest);

  const routes = useMemo(() => {
    const m = new Map();
    active.forEach((l) => { const k = `${l.from}|${l.to}`; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [listings]);

  const filtered = active.filter((l) =>
    (!f.from || l.from === f.from) && (!f.to || l.to === f.to) && (!f.role || l.role === f.role));
  const searching = f.from || f.to || f.role || all;

  const set = (patch) => { setF({ ...f, ...patch }); setShown(8); };
  const clear = () => { setF({ from: "", to: "", role: "" }); setAll(false); setShown(8); };

  return (
    <div>
      <div className="filters">
        <select value={f.from} onChange={(e) => set({ from: e.target.value })}><option value="">From: anywhere</option>{CITIES.map((c) => <option key={c}>{c}</option>)}</select>
        <select value={f.to} onChange={(e) => set({ to: e.target.value })}><option value="">To: anywhere</option>{CITIES.map((c) => <option key={c}>{c}</option>)}</select>
        <select value={f.role} onChange={(e) => set({ role: e.target.value })}>
          <option value="">Loads &amp; truck space</option><option value="load">Loads only</option><option value="truck">Truck space only</option>
        </select>
      </div>

      {!searching && (
        <>
          <div className="dim small" style={{ marginBottom: ".5rem" }}>
            {active.length === 0 ? "No active listings yet." : `${active.length} active listings. Pick a route:`}
          </div>
          <div className="chips">
            {routes.map(([k, n]) => {
              const [a, b] = k.split("|");
              return <button key={k} className="chip" onClick={() => setF({ from: a, to: b, role: "" })}>{a} → {b}<b>{n}</b></button>;
            })}
          </div>
          {active.length > 0 && <button className="ghost" onClick={() => setAll(true)}>Show all listings</button>}
        </>
      )}

      {searching && (
        <>
          <div className="row" style={{ marginBottom: ".7rem" }}>
            <span className="dim small">{filtered.length} listing{filtered.length === 1 ? "" : "s"}</span>
            <button className="link" onClick={clear}>Clear filters</button>
          </div>
          {filtered.length === 0 && <div className="empty">Nothing on this route yet. Try nearby cities, or post your own.</div>}
          {filtered.slice(0, shown).map((l) => {
            const mine = user && l.ownerId === user.uid;
            return (
              <div className="listing" key={l.id}>
                <div className="row">
                  <span className={`tag ${l.role}`}>{l.role === "load" ? "LOAD" : "TRUCK SPACE"}</span>
                  <span className="dim small">{dateLabel(l)}</span>
                </div>
                <div className="route">{l.from} → {l.to}</div>
                <div className="dim">{l.detail}{l.role === "truck" && <span className="badge">Verified driver</span>}{l.vehicleNo && <span className="badge">{l.vehicleNo}</span>}</div>
                <div className="dim small">Posted by {l.ownerName}</div>
                {mine ? <div className="dim small" style={{ marginTop: ".4rem" }}>Your listing</div>
                  : <button className="dark" onClick={() => onMessage(l)}>{!user ? "Sign in to message" : l.role === "load" && !verified ? "Verify to offer" : "Message"}</button>}
              </div>
            );
          })}
          {filtered.length > shown && <button className="ghost" onClick={() => setShown(shown + 8)}>Show more</button>}
        </>
      )}
    </div>
  );
}

/* ---------------- POST: form, KYC for drivers, my listings ---------------- */
function PostTab({ user, profile, kyc, listings, role, setRole, onEditProfile, setErr }) {
  const [from, setFrom] = useState(CITIES[0]);
  const [to, setTo] = useState(CITIES[1]);
  const [item, setItem] = useState("");
  const [vehicle, setVehicle] = useState(VEHICLES[0]);
  const [space, setSpace] = useState("Small");
  const [depart, setDepart] = useState(todayStr());
  const [arrive, setArrive] = useState(todayStr());
  const verified = kyc?.status === "verified";
  const mine = listings.filter((l) => l.ownerId === user.uid && (l.status || "open") !== "booked");

  async function submit(e) {
    e.preventDefault();
    if (from === to) { alert("Pick two different cities."); return; }
    if (!depart || depart < todayStr()) { alert("Pick a date that is today or later."); return; }
    if (role === "truck" && (!arrive || arrive < depart)) { alert("Arrival date can't be before departure."); return; }
    const data = {
      role, ownerId: user.uid, ownerName: profile.name, from, to, status: "open",
      departDate: depart, expiresAt: endOfDay(depart),
      detail: role === "load" ? (item.trim() || "Not specified") : `${vehicle} · ${space} space available`,
      createdAt: Date.now(),
    };
    if (role === "truck") {
      if (!kyc.vehicleNo) { alert("Please resubmit your verification with your vehicle details."); return; }
      data.vehicle = vehicle; data.space = space; data.vehicleNo = kyc.vehicleNo; data.arriveDate = arrive;
    }
    try { await addDoc(collection(db, "listings"), data); setItem(""); alert("Posted! Find it under the Find tab."); }
    catch (e2) { setErr(e2.message); }
  }
  async function fill(id) { try { await updateDoc(doc(db, "listings", id), { status: "filled" }); } catch (e) { setErr(e.message); } }
  async function remove(id) { if (confirm("Delete this listing?")) try { await deleteDoc(doc(db, "listings", id)); } catch (e) { setErr(e.message); } }

  return (
    <div>
      <div className="note bar">
        <span>Posting as {profile.name} · {profile.phone}</span>
        <button className="link" onClick={onEditProfile}>Edit</button>
      </div>
      <div className="card">
        <div className="tabs">
          <button type="button" className={role === "load" ? "on" : ""} onClick={() => setRole("load")}>I have a load to send</button>
          <button type="button" className={role === "truck" ? "on" : ""} onClick={() => setRole("truck")}>I have truck/loader space</button>
        </div>
        {role === "truck" && !verified ? (
          <KycPanel user={user} profile={profile} kyc={kyc} setErr={setErr} />
        ) : (
          <form onSubmit={submit}>
            {role === "truck" && <p className="good small">✓ Verified driver</p>}
            <div className="grid2">
              <div><label>From</label><select value={from} onChange={(e) => setFrom(e.target.value)}>{CITIES.map((c) => <option key={c}>{c}</option>)}</select></div>
              <div><label>To</label><select value={to} onChange={(e) => setTo(e.target.value)}>{CITIES.map((c) => <option key={c}>{c}</option>)}</select></div>
            </div>
            {role === "load" ? (
              <>
                <label>What needs moving? (item, rough size/weight)</label>
                <textarea value={item} onChange={(e) => setItem(e.target.value)} placeholder="e.g. 3-seater sofa + 2 chairs, needs 2 people to lift" />
              </>
            ) : (
              <div className="grid2">
                <div><label>Vehicle type</label><select value={vehicle} onChange={(e) => setVehicle(e.target.value)}>{VEHICLES.map((v) => <option key={v}>{v}</option>)}</select></div>
                <div><label>Space available</label><select value={space} onChange={(e) => setSpace(e.target.value)}><option>Small</option><option>Medium</option><option>Large</option></select></div>
              </div>
            )}
            {role === "load" ? (
              <>
                <label>Pickup date</label>
                <input type="date" min={todayStr()} value={depart} onChange={(e) => setDepart(e.target.value)} />
              </>
            ) : (
              <div className="grid2">
                <div><label>Departure date</label>
                  <input type="date" min={todayStr()} value={depart} onChange={(e) => { setDepart(e.target.value); if (arrive < e.target.value) setArrive(e.target.value); }} /></div>
                <div><label>Arrival date</label>
                  <input type="date" min={depart || todayStr()} value={arrive} onChange={(e) => setArrive(e.target.value)} /></div>
              </div>
            )}
            <p className="dim small" style={{ marginTop: 0 }}>Your listing disappears automatically after {role === "load" ? "the pickup" : "the departure"} date, or as soon as a deal is confirmed.</p>
            <button className="primary" type="submit">Post it</button>
          </form>
        )}
      </div>

      {mine.length > 0 && <h3>Your listings</h3>}
      {mine.map((l) => (
        <div className="listing" key={l.id}>
          <div className="row"><span className={`tag ${l.role}`}>{l.role === "load" ? "LOAD" : "TRUCK SPACE"}</span>
            <span className="dim small">{l.status === "booked" ? "Booked ✓" : l.status === "filled" ? "Marked filled" : dateLabel(l)}</span></div>
          <div className="route">{l.from} → {l.to}</div>
          <div className="dim">{l.detail}</div>
          <div style={{ display: "flex", gap: ".5rem" }}>
            {(l.status || "open") === "open" && <button className="ghost" onClick={() => fill(l.id)}>Mark filled</button>}
            <button className="ghost" onClick={() => remove(l.id)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function KycPanel({ user, profile, kyc, setErr }) {
  const [dl, setDl] = useState("");
  const [veh, setVeh] = useState("");
  const [f, setF] = useState({ doc: null, selfie: null, rc: null, permit: null });
  const [busy, setBusy] = useState(false);
  const pick = (k) => (e) => { const file = e.target.files[0] || null; setF((p) => ({ ...p, [k]: file })); };

  if (kyc?.status === "pending") {
    return <div className="note">Your documents are <b>under review</b>. You’ll be able to post truck space and offer on loads once they’re approved.</div>;
  }

  async function submit(e) {
    e.preventDefault();
    const cleanDl = dl.toUpperCase().replace(/[\s-]/g, "");
    const cleanVeh = veh.toUpperCase().replace(/[\s-]/g, "");
    if (!/^[A-Z]{2}\d{12,14}$/.test(cleanDl)) { alert("Enter your driving licence number as printed on the card, e.g. MH12 20190012345."); return; }
    if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(cleanVeh)) { alert("Enter the vehicle number as on the number plate, e.g. MH12 AB 1234."); return; }
    if (!f.doc || !f.selfie || !f.rc || !f.permit) { alert("Please add all four photos."); return; }
    setBusy(true);
    try {
      const [docImage, selfie, rcImage, permitImage] = await Promise.all([
        compress(f.doc, 800, 0.55), compress(f.selfie, 600, 0.5), compress(f.rc, 800, 0.55), compress(f.permit, 800, 0.55)]);
      if (docImage.length + selfie.length + rcImage.length + permitImage.length > 900000)
        throw new Error("Photos are too large — retake them closer and in good light.");
      await setDoc(doc(db, "kyc", user.uid), {
        name: profile.name, dlNumber: cleanDl, vehicleNo: cleanVeh,
        docImage, selfie, rcImage, permitImage, status: "pending", submittedAt: Date.now(),
      });
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  }

  return (
    <form onSubmit={submit}>
      <h2 style={{ marginTop: 0 }}>Verify yourself and your vehicle</h2>
      {kyc?.status === "rejected" && <div className="note err">Rejected{kyc.reason ? `: ${kyc.reason}` : ""}. Please resubmit.</div>}
      <p className="dim small">Needed once, before you can post truck space or chat and make offers on loads. Only commercial goods vehicles with a valid goods-carriage permit can be approved. Photos are private: only you and the reviewer can see them.</p>
      <label>Driving licence number</label>
      <input value={dl} onChange={(e) => setDl(e.target.value)} placeholder="e.g. MH12 20190012345" />
      <label>Vehicle number (number plate)</label>
      <input value={veh} onChange={(e) => setVeh(e.target.value)} placeholder="e.g. MH12 AB 1234" />
      <label>Photo of your driving licence (front, text readable)</label>
      <input type="file" accept="image/*" capture="environment" onChange={pick("doc")} />
      <label>Selfie holding the same licence</label>
      <input type="file" accept="image/*" capture="user" onChange={pick("selfie")} />
      <label>Photo of the vehicle’s RC (registration certificate)</label>
      <input type="file" accept="image/*" capture="environment" onChange={pick("rc")} />
      <label>Photo of goods-carriage permit, fitness and insurance (one clear photo, or a collage)</label>
      <input type="file" accept="image/*" capture="environment" onChange={pick("permit")} />
      <button className="primary" type="submit" disabled={busy}>{busy ? "Uploading…" : "Submit for verification"}</button>
    </form>
  );
}

/* ---------------- ADMIN: approve or reject KYC ---------------- */
function AdminPanel({ setErr }) {
  const [items, setItems] = useState([]);
  useEffect(() => onSnapshot(query(collection(db, "kyc"), where("status", "==", "pending")),
    (s) => setItems(s.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => setErr(e.message)), []);

  async function decide(id, status) {
    let reason = "";
    if (status === "rejected") { reason = prompt("Reason (shown to the driver):") || ""; }
    try { await updateDoc(doc(db, "kyc", id), { status, reason, reviewedAt: Date.now() }); } catch (e) { setErr(e.message); }
  }
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Pending KYC ({items.length})</h3>
      {items.length === 0 && <div className="empty">Nothing waiting for review.</div>}
      {items.map((k) => (
        <div className="listing" key={k.id}>
          <div className="route">{k.name}</div>
          <div className="dim">DL: {k.dlNumber} · Vehicle: {k.vehicleNo}</div>
          <div className="dim small">Check: selfie matches licence · DL valid for this vehicle class · RC is a commercial goods vehicle · goods-carriage permit valid · fitness valid · insurance valid.</div>
          <div className="kycimgs">
            <img src={k.docImage} alt="licence" /><img src={k.selfie} alt="selfie" />
            {k.rcImage && <img src={k.rcImage} alt="RC" />}{k.permitImage && <img src={k.permitImage} alt="permit and insurance" />}
          </div>
          <div style={{ display: "flex", gap: ".5rem" }}>
            <button className="dark" onClick={() => decide(k.id, "verified")}>Approve</button>
            <button className="ghost" onClick={() => decide(k.id, "rejected")}>Reject</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- CHAT + DEAL / BOOKING CODE ---------------- */
function ChatPanel({ user, chat, listings, onClose, setErr }) {
  const [msgs, setMsgs] = useState([]);
  const [thread, setThread] = useState(null);
  const [text, setText] = useState("");
  const endRef = useRef(null);

  useEffect(() => {
    const u1 = onSnapshot(query(collection(db, "threads", chat.id, "messages"), orderBy("createdAt", "asc"), limit(300)),
      (s) => setMsgs(s.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => setErr(e.message));
    const u2 = onSnapshot(doc(db, "threads", chat.id), (s) => setThread(s.exists() ? s.data() : null), (e) => setErr(e.message));
    return () => { u1(); u2(); };
  }, [chat.id]);
  useEffect(() => { endRef.current?.scrollIntoView(); }, [msgs]);

  async function send(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    try {
      await addDoc(collection(db, "threads", chat.id, "messages"), { senderId: user.uid, text: t, createdAt: Date.now() });
      await updateDoc(doc(db, "threads", chat.id), { lastMessage: t, updatedAt: Date.now() });
    } catch (e2) { setErr(e2.message); }
  }

  async function setDeal(patch, note, after) {
    try {
      await updateDoc(doc(db, "threads", chat.id), { ...patch, lastMessage: note, updatedAt: Date.now() });
      await addDoc(collection(db, "threads", chat.id, "messages"), { senderId: user.uid, text: note, system: true, createdAt: Date.now() });
      if (after) await after();
    } catch (e) { setErr(e.message); }
  }

  // Deal confirmed: take the listing being discussed off the board, plus the other person's
  // matching listing on the same route if they have exactly one. Nobody else can see them.
  async function closeListings() {
    const main = listings.find((l) => l.id === thread?.listingId);
    if (!main) return;
    const ids = [main.id];
    const inquirer = thread.participants.find((p) => p !== main.ownerId);
    const matches = listings.filter((l) => l.ownerId === inquirer && l.role !== main.role && l.from === main.from && l.to === main.to && isActive(l));
    if (matches.length === 1) ids.push(matches[0].id);
    await updateDoc(doc(db, "threads", chat.id), { toClose: ids });
    for (const id of ids) {
      try { await updateDoc(doc(db, "listings", id), { status: "booked", bookedThread: chat.id }); } catch (e) { /* each owner's app also closes their own */ }
    }
  }

  // Booking cancelled: put those listings back on the board (if their date hasn't passed).
  async function reopenListings() {
    for (const id of thread?.toClose || []) {
      const l = listings.find((x) => x.id === id);
      if (!l || (l.expiresAt && l.expiresAt < Date.now())) continue;
      try { await updateDoc(doc(db, "listings", id), { status: "open", bookedThread: chat.id }); } catch (e) { /* skip */ }
    }
  }

  const main = listings.find((l) => l.id === thread?.listingId);
  const unavailable = !!thread?.listingId && listings.length > 0 &&
    (!main || ((main.status || "open") !== "open" && main.bookedThread !== chat.id) || !!(main.expiresAt && main.expiresAt < Date.now()));

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel">
        <div className="phead">
          <div><div className="route">{chat.title}</div><div className="dim small">{chat.sub}</div></div>
          <button className="link" onClick={onClose}>✕</button>
        </div>
        {thread && thread.driverId && <DealBar user={user} thread={thread} unavailable={unavailable} setDeal={setDeal} closeListings={closeListings} reopenListings={reopenListings} />}
        <div className="msgs">
          {msgs.length === 0 && <div className="empty">Say hello to start the conversation.</div>}
          {msgs.map((m) => m.system
            ? <div key={m.id} className="sys">{m.text}</div>
            : <div key={m.id} className={`bubble ${m.senderId === user.uid ? "mine" : "theirs"}`}>{m.text}</div>)}
          <div ref={endRef} />
        </div>
        <form className="send" onSubmit={send}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message…" />
          <button className="primary" type="submit">Send</button>
        </form>
      </div>
    </div>
  );
}

function DealBar({ user, thread, unavailable, setDeal, closeListings, reopenListings }) {
  const [price, setPrice] = useState("");
  const st = thread.dealStatus || "none";
  const iDriver = thread.driverId === user.uid;
  const mineProposal = thread.dealBy === user.uid;
  if (unavailable && (st === "none" || st === "proposed"))
    return <div className="dealbar dim">This listing has already been booked or is no longer available.</div>;

  if (st === "none") return (
    <div className="dealbar">
      <div>Agreed on a price? Lock it in and get a booking code.</div>
      <div className="acts">
        <input inputMode="numeric" placeholder="₹ price" value={price} onChange={(e) => setPrice(digits(e.target.value, 7))} />
        <button className="dark" onClick={() => price && setDeal({ dealStatus: "proposed", dealPrice: Number(price), dealBy: user.uid }, `Deal proposed: ₹${price}`)}>Propose deal</button>
      </div>
    </div>
  );
  if (st === "proposed") return (
    <div className="dealbar">
      <div>Proposed price: <b>₹{thread.dealPrice}</b></div>
      <div className="acts">
        {mineProposal ? (
          <>
            <span className="dim">Waiting for the other person to accept…</span>
            <button className="ghost" onClick={() => setDeal({ dealStatus: "none" }, "Proposal withdrawn")}>Withdraw</button>
          </>
        ) : (
          <>
            <button className="primary" onClick={() => { const c = genCode(); setDeal({ dealStatus: "confirmed", dealCode: c }, `Deal confirmed at ₹${thread.dealPrice} · Booking code ${c}`, closeListings); }}>Accept</button>
            <button className="ghost" onClick={() => setDeal({ dealStatus: "none" }, "Proposal declined")}>Decline</button>
          </>
        )}
      </div>
    </div>
  );
  if (st === "confirmed") return (
    <div className="dealbar">
      <div>Booking code <span className="code">{thread.dealCode}</span> · ₹{thread.dealPrice}</div>
      <div className="dim small">Both of you have this code. Quote it when you meet at pickup.</div>
      <div className="acts">
        {iDriver ? <button className="primary" onClick={() => setDeal({ dealStatus: "picked_up" }, "Driver marked: picked up")}>Mark picked up</button>
          : <span className="dim">Waiting for pickup…</span>}
        <button className="ghost" onClick={() => confirm("Cancel this booking?") && setDeal({ dealStatus: "cancelled" }, "Booking cancelled", reopenListings)}>Cancel booking</button>
      </div>
    </div>
  );
  if (st === "picked_up") return (
    <div className="dealbar">
      <div>Booking <span className="code">{thread.dealCode}</span> · in transit</div>
      <div className="acts">
        {iDriver ? <span className="dim">Waiting for the shipper to confirm delivery…</span>
          : <button className="primary" onClick={() => setDeal({ dealStatus: "delivered" }, "Shipper confirmed: delivered")}>Confirm delivered</button>}
      </div>
    </div>
  );
  if (st === "delivered") return <div className="dealbar"><span className="good">✓ Completed</span> · Booking {thread.dealCode} · ₹{thread.dealPrice}</div>;
  return <div className="dealbar dim">Booking cancelled. You can propose a new deal.
    <div className="acts"><button className="ghost" onClick={() => setDeal({ dealStatus: "none" }, "Ready for a new deal")}>Start over</button></div></div>;
}
