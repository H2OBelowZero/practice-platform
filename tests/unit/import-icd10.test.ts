import { describe, it, expect } from "vitest";
import { BATCH, checkRows, chunks, CODE_RE, detectDelimiter, parseArgs, parseCsv, pickColumns, prepare } from "../../scripts/import-icd10.mjs";

describe("scripts/import-icd10.mjs: reading the CSV", () => {
  it("parses quoted fields with separators, doubled quotes and line breaks; drops blank lines; strips a byte-order mark", () => {
    const text = '﻿ICD10_Code,WHO_Full_Desc\r\nF32.9,"Depressive episode, unspecified"\n\nF41.1,"He said ""anxious""\nnew line"\r\n';
    expect(parseCsv(text)).toEqual([["ICD10_Code", "WHO_Full_Desc"], ["F32.9", "Depressive episode, unspecified"], ["F41.1", 'He said "anxious"\nnew line']]);
  });
  it("detects a semicolon-separated export", () => {
    expect(detectDelimiter("Code;Description")).toBe(";");
    expect(detectDelimiter("Code,Description;x")).toBe(",");
    expect(parseCsv("Code;Description\nF32.9;Depressive episode, unspecified")).toEqual([["Code", "Description"], ["F32.9", "Depressive episode, unspecified"]]);
  });
  it("refuses a file that ends inside quotes", () => {
    expect(() => parseCsv('Code,Description\nF32.9,"never closed')).toThrow(/quoted field/);
  });
  it("finds the code and description columns, or uses the names given", () => {
    expect(pickColumns(["Chapter", "ICD10_Code", "WHO_Full_Desc", "Valid_ICD10_Primary"])).toEqual({ code: 1, description: 2 });
    expect(pickColumns(["code_a", "code_b", "Short desc", "Full desc"], { codeColumn: "CODE_B", descriptionColumn: "full desc" })).toEqual({ code: 1, description: 3 });
    expect(() => pickColumns(["a", "b"])).toThrow(/no code column/);
    expect(() => pickColumns(["code", "b"])).toThrow(/no description column/);
    expect(() => pickColumns(["code", "desc"], { codeColumn: "missing" })).toThrow(/no code column/);
  });
});

describe("scripts/import-icd10.mjs: checking the rows", () => {
  it("accepts F32, F32.9 and M54.56 style codes (the database's rule) and nothing else", () => {
    for (const ok of ["F32", "F32.9", "M54.56", "Z63.0", "U07.1"]) expect(CODE_RE.test(ok), ok).toBe(true);
    for (const bad of ["F3", "32.9", "F32.", "F32.123", "f32.9", "F32 9", "", "F32.9+"]) expect(CODE_RE.test(bad), bad).toBe(false);
  });
  it("normalises codes, reports rejected rows with their file line numbers, keeps the first of a duplicate", () => {
    const rows = [[" f32.9 ", " Depressive episode, unspecified "], ["F3", "too short"], ["F41.1", ""], ["F32.9", "again"], ["F43.1", "x".repeat(501)], ["M54.56", "Low back pain"]];
    const r = checkRows(rows, { code: 0, description: 1 });
    expect(r.valid).toEqual([{ code: "F32.9", description: "Depressive episode, unspecified" }, { code: "M54.56", description: "Low back pain" }]);
    expect(r.invalid.map((x: { line: number }) => x.line)).toEqual([3, 4, 6]); // header is line 1
    expect(r.duplicates).toEqual([{ line: 5, code: "F32.9" }]);
  });
  it("prepare() reads a whole file and needs data under the header", () => {
    expect(prepare("Code,Description\nF32.9,Depressive episode\nX,bad")).toMatchObject({ rows: 2, valid: [{ code: "F32.9", description: "Depressive episode" }], invalid: [{ line: 3, code: "X" }] });
    expect(() => prepare("Code,Description\n")).toThrow(/no data rows/);
  });
  it("sends batches of 500", () => {
    expect(BATCH).toBe(500);
    const items = Array.from({ length: 1201 }, (_, i) => i);
    expect(chunks(items).map((c: number[]) => c.length)).toEqual([500, 500, 201]);
    expect(chunks([])).toEqual([]);
  });
  it("command-line options: the file, --dry-run and the column names", () => {
    expect(parseArgs(["mit.csv", "--dry-run", "--code-column", "ICD10_Code", "--description-column", "WHO_Full_Desc"]))
      .toEqual({ file: "mit.csv", dryRun: true, codeColumn: "ICD10_Code", descriptionColumn: "WHO_Full_Desc" });
    expect(parseArgs(["mit.csv"])).toMatchObject({ file: "mit.csv", dryRun: false });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["a.csv", "--force"])).toThrow(/unknown option/);
    expect(() => parseArgs(["a.csv", "b.csv"])).toThrow(/unexpected argument/);
  });
});
