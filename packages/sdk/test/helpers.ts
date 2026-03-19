import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export async function createPdfFixture(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.setTitle('Fixture Book');
  document.setAuthor('Summ Tempo');

  const font = await document.embedFont(StandardFonts.Helvetica);
  const pageOne = document.addPage([612, 792]);
  pageOne.drawText(
    'Chapter 1\n\nThis is the first page of the fixture book. It contains enough text to prove PDF parsing works locally.',
    { x: 72, y: 720, size: 14, font, lineHeight: 18 }
  );

  const pageTwo = document.addPage([612, 792]);
  pageTwo.drawText(
    'Chapter 2\n\nThis second page keeps the extraction simple and deterministic for tests.',
    { x: 72, y: 720, size: 14, font, lineHeight: 18 }
  );

  return Buffer.from(await document.save());
}

export async function createBlankPdfFixture(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  return Buffer.from(await document.save());
}

export async function createEpubFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Fixture EPUB</dc:title>
    <dc:creator>Summ Tempo</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>`
  );

  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="chapter1.xhtml">Chapter One</a></li>
        <li><a href="chapter2.xhtml">Chapter Two</a></li>
      </ol>
    </nav>
  </body>
</html>`
  );

  zip.file(
    'OEBPS/chapter1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1>Chapter One</h1>
    <p>This is the first chapter of the fixture EPUB.</p>
    <p>It exists to validate local EPUB parsing and chunking.</p>
  </body>
</html>`
  );

  zip.file(
    'OEBPS/chapter2.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1>Chapter Two</h1>
    <p>This is the second chapter.</p>
    <p>It gives the parser a second spine item to read.</p>
  </body>
</html>`
  );

  return await zip.generateAsync({ type: 'nodebuffer' });
}

export async function createMalformedEpubFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  return await zip.generateAsync({ type: 'nodebuffer' });
}
