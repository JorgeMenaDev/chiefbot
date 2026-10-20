"use client";

import { useEffect, useState, type FormEvent } from "react";

// The browser calls the gateway on its fixed port, whichever origin served this
// page. From http://localhost:3000 that is a cross-origin call, which the gateway's
// CORS allows for that origin only.
const API = "http://localhost:8081/acme-meta/v1";

type Identity = { id: string; name: string; groups: string[] };
type Row = { id: number; name: string; note: string; createdBy: string };

// Sends the dev login's `token` cookie as a Bearer header.
async function api(path: string, init?: RequestInit) {
  const token = /(?:^|; )token=([^;]*)/.exec(document.cookie)?.[1] ?? "";
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return response.json();
}

export default function RecordsPage() {
  const [me, setMe] = useState<Identity>();
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>();

  async function load() {
    const identity: Identity = await api("/me");
    const records: Row[] = await api("/records");
    setMe(identity);
    setRows(records);
  }

  useEffect(() => {
    load().catch((e: unknown) => setError(String(e)));
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    try {
      await api("/records", {
        method: "POST",
        body: JSON.stringify({ name: fields.get("name"), note: fields.get("note") }),
      });
      form.reset();
      setError(undefined);
      await load();
    } catch (e: unknown) {
      setError(String(e));
    }
  }

  return (
    <main>
      <h1>Records</h1>
      {me && <p>Signed in as {me.name}</p>}
      {error && <p role="alert">{error}</p>}
      <table>
        <thead>
          <tr>
            <th align="left">Name</th>
            <th align="left">Note</th>
            <th align="left">Created by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.name}</td>
              <td>{row.note}</td>
              <td>{row.createdBy}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={create} style={{ marginTop: "1rem" }}>
        <input name="name" aria-label="Name" placeholder="Name" required />{" "}
        <input name="note" aria-label="Note" placeholder="Note" />{" "}
        <button>Create</button>
      </form>
    </main>
  );
}
