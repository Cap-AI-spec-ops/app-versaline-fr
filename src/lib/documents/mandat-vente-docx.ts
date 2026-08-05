import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

import {
  buildMandatVenteContractSections,
  type MandatVenteContractSection,
} from "@/lib/documents/mandat-vente-contract";
import type { MandatVenteData } from "@/lib/documents/schemas";

export async function renderMandatVenteDocx(data: MandatVenteData): Promise<Buffer> {
  const sections = buildMandatVenteContractSections(data);
  const paragraphs: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: data.title, bold: true })],
      spacing: { after: 220 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "Mandat de vente" })],
      spacing: { after: 320 },
    }),
  ];

  for (const section of sections) {
    appendSectionParagraphs(paragraphs, section);
  }

  if (data.specialClauses.length > 0) {
    paragraphs.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "Clauses particulieres", bold: true })],
        spacing: { before: 260, after: 120 },
      }),
    );

    for (const clause of data.specialClauses) {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun(`- ${clause}`)],
          spacing: { after: 90 },
        }),
      );
    }
  }

  const document = new Document({
    sections: [
      {
        properties: {},
        children: paragraphs,
      },
    ],
  });

  return Packer.toBuffer(document);
}

function appendSectionParagraphs(output: Paragraph[], section: MandatVenteContractSection) {
  output.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: section.title, bold: true })],
      spacing: { before: 240, after: 120 },
    }),
  );

  for (const paragraph of section.paragraphs) {
    output.push(
      new Paragraph({
        children: [new TextRun(paragraph)],
        spacing: { after: 110 },
      }),
    );
  }

  for (const bullet of section.bulletLines ?? []) {
    output.push(
      new Paragraph({
        children: [new TextRun(`- ${bullet}`)],
        spacing: { after: 80 },
      }),
    );
  }
}
