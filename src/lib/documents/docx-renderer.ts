import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

type TemplateData = Record<string, any>;

const PLACEHOLDER_REGEX = /\{\s*([a-zA-Z0-9_.-]+)\s*\}/g;

export function renderDocxTemplate(fileBuffer: Buffer, data: TemplateData): Buffer {
  const zip = new PizZip(fileBuffer);
  const document = new Docxtemplater(zip, {
    linebreaks: true,
    paragraphLoop: true,
  });

  document.render(sanitizeTemplateData(data));

  return document.getZip().generate({ type: "nodebuffer" }) as Buffer;
}

export function extractDocxPlaceholders(fileBuffer: Buffer): string[] {
  const zip = new PizZip(fileBuffer);
  const placeholders = new Set<string>();

  for (const fileName of Object.keys(zip.files)) {
    if (!fileName.startsWith("word/") || !fileName.endsWith(".xml")) {
      continue;
    }

    const xml = zip.file(fileName)?.asText() ?? "";
    const normalizedXml = xml.replace(/<[^>]+>/g, " ");

    for (const match of normalizedXml.matchAll(PLACEHOLDER_REGEX)) {
      const placeholder = match[1]?.trim();

      if (placeholder) {
        placeholders.add(placeholder);
      }
    }
  }

  return Array.from(placeholders).sort((left, right) => left.localeCompare(right));
}

function sanitizeTemplateData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTemplateData(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, sanitizeTemplateData(nestedValue)]),
    );
  }

  if (value === null || value === undefined) {
    return "";
  }

  return value;
}