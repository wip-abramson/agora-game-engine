import { expect, test } from "vitest";
import { empty, play } from "./engine";
import { decode, DOC, HASH } from "./protocol";

test("HASH is the Agora hash of DOC", async () => {
  const sha1 = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(DOC)));
  expect(btoa(String.fromCharCode(...sha1))).toBe(HASH);
});

test("decodes a legal move and refuses bad bodies", () => {
  const b = play(empty(), 5, "X");
  expect(decode('{"cell":1}', b, "O")).toEqual({ cell: 1 });
  expect(decode('{"cell":5}', b, "O")).toEqual({ error: "cell 5 is taken" });
  expect(decode("centre", b, "O")).toEqual({ error: "body is not JSON" });
  expect(decode('{"cell":"1"}', b, "O")).toEqual({ error: "cells are numbered 1 to 9" });
});
