// @vitest-environment node
import { expect, test } from "vite-plus/test";
import { H264AccessUnits } from "./native-browser-video";

const aud = Buffer.from([0, 0, 1, 9, 0xf0]);
const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0x99]);
const pps = Buffer.from([0, 0, 1, 0x68, 0xaa]);
const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x99]);
const delta = Buffer.from([0, 0, 1, 0x41, 0x88]);

// Two complete units plus a following NAL to delimit the last AUD.
const input = Buffer.concat([aud, sps, pps, idr, aud, delta, aud, delta]);

test("Annex-B access units survive every two-chunk boundary, including mixed start codes and SPS", () => {
  for (let boundary = 1; boundary < input.length; boundary++) {
    const frames: Array<{ data: Buffer; key: boolean; codec: string }> = [];
    const parser = new H264AccessUnits((data, key, codec) => frames.push({ data, key, codec }));
    parser.push(input.subarray(0, boundary));
    parser.push(input.subarray(boundary));
    expect(frames).toEqual([
      { data: Buffer.concat([aud, sps, pps, idr]), key: true, codec: "avc1.42c01f" },
      { data: Buffer.concat([aud, delta]), key: false, codec: "avc1.42c01f" },
    ]);
  }
});

test("byte-at-a-time delivery retains all dependent frames and inherited codec metadata", () => {
  const frames: Array<{ data: Buffer; key: boolean; codec: string }> = [];
  const parser = new H264AccessUnits((data, key, codec) => frames.push({ data, key, codec }));
  for (const byte of input) parser.push(Buffer.from([byte]));
  expect(frames).toEqual([
    { data: Buffer.concat([aud, sps, pps, idr]), key: true, codec: "avc1.42c01f" },
    { data: Buffer.concat([aud, delta]), key: false, codec: "avc1.42c01f" },
  ]);
});

test("a unit without decoder configuration fails rather than emitting undecodable video", () => {
  const parser = new H264AccessUnits(() => {});
  expect(() => parser.push(Buffer.concat([aud, idr, aud, delta]))).toThrow("omitted SPS");
});

test("an access unit cannot accumulate unlimited complete NALs without an AUD", () => {
  const parser = new H264AccessUnits(() => {});
  parser.push(Buffer.concat([aud, sps, delta]));
  const slice = Buffer.concat([delta, Buffer.alloc(1024 * 1024, 0xff)]);
  expect(() => {
    for (let i = 0; i < 17; i++) parser.push(slice);
  }).toThrow("exceeds limit");
});

test("completed NALs and an unfinished NAL share the same access-unit budget", () => {
  const parser = new H264AccessUnits(() => {});
  parser.push(Buffer.concat([aud, sps, delta, Buffer.alloc(8 * 1024 * 1024, 0xff), delta]));
  expect(() => parser.push(Buffer.alloc(8 * 1024 * 1024, 0xff))).toThrow("exceeds limit");
});

test("tiny NALs without an AUD cannot exhaust heap through Buffer/array overhead", () => {
  const parser = new H264AccessUnits(() => {});
  const units = Buffer.alloc(delta.length * 16_386);
  for (let i = 0; i < 16_386; i++) delta.copy(units, i * delta.length);
  expect(() => parser.push(units)).toThrow("NAL count exceeds limit");
});

test("a single unterminated NAL has a bounded pending buffer", () => {
  const parser = new H264AccessUnits(() => {});
  expect(() => parser.push(Buffer.alloc(16 * 1024 * 1024 + 1, 0xff))).toThrow("exceeds limit");
});
