"use client";

import { useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { MAX_LINES } from "@/lib/billing/input";
import { PAYER_LABEL } from "@/lib/billing/list";
import { FieldErrorContext } from "./keep-form";

export type FieldsInitial = {
  lines: { description: string; quantity: string; price: string }[];
  discount: string; dueDate: string; payer: string; scheme: string;
};

/**
 * The fields of the create / edit-draft invoice form, inside an ActionForm. Lines are added and removed here; each row submits as
 * line_desc_N / line_qty_N / line_price_N (the server sorts by N). No totals are submitted or trusted: the server works out the
 * subtotal, VAT, total and portions on save.
 */
export function InvoiceFields({ initial, minDue }: { initial: FieldsInitial; minDue: string }) {
  const [rows, setRows] = useState(() => (initial.lines.length ? initial.lines : [{ description: "", quantity: "1", price: "" }]).map((l, key) => ({ key, ...l })));
  const [nextKey, setNextKey] = useState(Math.max(1, initial.lines.length));
  const [payer, setPayer] = useState(initial.payer);
  const fe = useContext(FieldErrorContext);
  const err = (id: string) => (fe.field === id ? fe.error : undefined);
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => { if (focusId) { document.getElementById(focusId)?.focus(); setFocusId(null); } }, [focusId]); // after a line is added or removed

  return (
    <>
      <div className="mb-5 grid gap-4">
        {rows.map((r, i) => (
          <fieldset key={r.key} className="rounded-xl border border-line p-4">
            <legend className="px-2 font-medium">Line {i + 1}</legend>
            <Input id={`line_desc_${r.key}`} label="Description" defaultValue={r.description} maxLength={200} error={err(`line_desc_${r.key}`)} />
            <div className="grid gap-x-4 sm:grid-cols-2">
              <Input id={`line_qty_${r.key}`} label="Quantity" type="number" inputMode="numeric" min={1} max={99} step={1} defaultValue={r.quantity} error={err(`line_qty_${r.key}`)} />
              <Input id={`line_price_${r.key}`} label="Price each (rand)" inputMode="decimal" defaultValue={r.price} placeholder="950,00" hint="Excluding VAT." error={err(`line_price_${r.key}`)} />
            </div>
            {rows.length > 1 && <Button variant="quiet" onClick={() => { const keep = rows.filter((x) => x.key !== r.key); setRows(keep); setFocusId(`line_desc_${(keep[i - 1] ?? keep[0]).key}`); }}>Remove line {i + 1}</Button>}
          </fieldset>
        ))}
        {rows.length < MAX_LINES && (
          <div><Button variant="secondary" onClick={() => { setRows([...rows, { key: nextKey, description: "", quantity: "1", price: "" }]); setNextKey(nextKey + 1); setFocusId(`line_desc_${nextKey}`); }}>Add a line</Button></div>
        )}
      </div>

      <div className="grid gap-x-4 sm:grid-cols-2">
        <Input id="discount" label="Discount (rand)" inputMode="decimal" defaultValue={initial.discount} placeholder="0,00" hint="Taken off the subtotal before VAT. Optional." error={err("discount")} />
        <Input id="dueDate" label="Due date" type="date" required min={minDue} defaultValue={initial.dueDate} error={err("dueDate")} />
      </div>

      <Select id="payer" label="Who pays" error={err("payer")} value={payer} onChange={(e) => setPayer(e.target.value)}>
        {Object.entries(PAYER_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
      {payer === "medical_aid" && <p className="-mt-3 mb-5 text-sm text-ink-muted">The whole total is billed to the medical aid; the patient portion is R 0,00.</p>}
      {payer === "split" && (
        <Input id="scheme" label="Medical aid portion (rand)" inputMode="decimal" defaultValue={initial.scheme} placeholder="600,00" error={err("scheme")}
               hint="The patient portion is the total minus this amount, worked out when you save." />
      )}
      <p className="mb-5 text-sm text-ink-muted">Totals, VAT and the portions are calculated when you save, using the practice VAT settings.</p>
    </>
  );
}
