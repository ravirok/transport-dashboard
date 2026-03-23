from flask import Flask, request, jsonify
import random

app = Flask(__name__)

@app.route("/analyze", methods=["POST"])
def analyze():
    transports = request.json.get("transports", [])

    enriched = []
    for t in transports:
        risk = random.random()

        enriched.append({
            **t,
            "RiskScore": risk,
            "Status": "Failed" if risk > 0.7 else "Success",
            "FailedObjects": [
                {"ObjectName": "Z_PROGRAM", "Type": "ABAP", "Error": "Syntax Error"}
            ] if risk > 0.7 else [],
            "Logs": [
                "Syntax error detected"
            ] if risk > 0.7 else []
        })

    return jsonify({"results": enriched})

if __name__ == "__main__":
    app.run(port=5000)
