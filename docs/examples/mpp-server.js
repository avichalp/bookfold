const baseUrl = process.env.BOOKFOLD_BASE_URL ?? 'http://localhost:8787';

async function main() {
  const uploadResponse = await fetch(`${baseUrl}/v1/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fileName: 'book.pdf',
      contentType: 'application/pdf',
      sizeBytes: 123456
    })
  });
  const upload = await uploadResponse.json();
  console.log('upload', upload);

  // Upload the file to Blob with upload.upload.clientToken here.

  const quoteResponse = await fetch(`${baseUrl}/v1/quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      uploadId: upload.fileId,
      detail: 'short'
    })
  });
  const quote = await quoteResponse.json();
  console.log('quote', quote);

  const jobCreate = await fetch(`${baseUrl}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteId: quote.quoteId })
  });

  if (jobCreate.status === 402) {
    console.log('MPP challenge', jobCreate.headers.get('www-authenticate'));
    console.log('Retry the same request with your MPP client.');
    return;
  }

  const job = await jobCreate.json();
  console.log('job', job);

  const jobStatus = await fetch(`${baseUrl}/v1/jobs/${job.jobId}`);
  console.log('status', await jobStatus.json());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
