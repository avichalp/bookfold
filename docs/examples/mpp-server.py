import json
import os

import requests


BASE_URL = os.environ.get("BOOKFOLD_BASE_URL", "http://localhost:8787")


def main() -> None:
    upload_response = requests.post(
        f"{BASE_URL}/v1/uploads",
        headers={"content-type": "application/json"},
        data=json.dumps(
            {
                "fileName": "book.pdf",
                "contentType": "application/pdf",
                "sizeBytes": 123456,
            }
        ),
        timeout=30,
    )
    upload = upload_response.json()
    print("upload", json.dumps(upload, indent=2))

    # Upload the file to Blob with upload["upload"]["clientToken"] here.

    quote_response = requests.post(
        f"{BASE_URL}/v1/quotes",
        headers={"content-type": "application/json"},
        data=json.dumps(
            {
                "uploadId": upload["fileId"],
                "detail": "short",
            }
        ),
        timeout=120,
    )
    quote = quote_response.json()
    print("quote", json.dumps(quote, indent=2))

    job_response = requests.post(
        f"{BASE_URL}/v1/jobs",
        headers={"content-type": "application/json"},
        data=json.dumps({"quoteId": quote["quoteId"]}),
        timeout=30,
    )

    if job_response.status_code == 402:
        print("MPP challenge", job_response.headers.get("WWW-Authenticate"))
        print("Retry the same request with your MPP client.")
        return

    job = job_response.json()
    print("job", json.dumps(job, indent=2))

    status_response = requests.get(
        f"{BASE_URL}/v1/jobs/{job['jobId']}",
        timeout=30,
    )
    print("status", json.dumps(status_response.json(), indent=2))


if __name__ == "__main__":
    main()
