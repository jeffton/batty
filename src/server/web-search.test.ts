import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vite-plus/test";
import { runWebSearch } from "./web-search";

function textPdf(): Buffer {
  const stream = "BT /F1 12 Tf 72 720 Td (Dependency PDF extraction) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("web content extracts PDF text through the ESM worker and handles invalid documents", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/pdf" });
    response.end(request.url === "/valid.pdf" ? textPdf() : Buffer.from("not a PDF"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const filename of ["valid.pdf", "invalid.pdf", "valid.pdf"]) {
      const result = await runWebSearch({
        action: "content",
        apiKey: "unused-local-fixture",
        url: `${base}/${filename}`,
      });
      if (filename === "valid.pdf") {
        expect(result.details.content).toContain("Dependency PDF extraction");
      } else {
        expect(result.details.content).toContain("Invalid PDF structure");
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
