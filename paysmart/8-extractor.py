"""Reads a receipt image and returns {amount, transaction_id, sender}.

GeminiExtractor calls the Gemini API (needs GEMINI_API_KEY and network).
FakeExtractor is for tests and demos.
"""
import base64
import json
import os
import urllib.request

PROMPT = (
    "This is a screenshot of an Egyptian bank transfer / InstaPay / mobile wallet receipt. "
    "Return ONLY JSON with keys: amount (number, EGP), transaction_id (string), sender (string). "
    "Use null for anything you cannot read clearly. Do not guess."
)


class GeminiExtractor:
    def __init__(self, api_key=None, model="gemini-2.0-flash"):
        self.api_key = api_key or os.environ["GEMINI_API_KEY"]
        self.model = model

    def extract(self, image_bytes, mime="image/jpeg"):
        url = (f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}"
               f":generateContent?key={self.api_key}")
        body = {
            "contents": [{"parts": [
                {"text": PROMPT},
                {"inline_data": {"mime_type": mime, "data": base64.b64encode(image_bytes).decode()}},
            ]}],
            "generationConfig": {"response_mime_type": "application/json"},
        }
        req = urllib.request.Request(url, json.dumps(body).encode(),
                                     {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text)


class FakeExtractor:
    def __init__(self, result):
        self.result = result

    def extract(self, image_bytes, mime="image/jpeg"):
        return self.result
