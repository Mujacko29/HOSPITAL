# HospitalQueueAI

A Node.js and Express queue-management prototype for patients and hospital staff.

## Features

- Patient registration, sign-in, and queue ticket cancellation
- Live queue position, wait estimates, and notifications
- Staff dashboard for departments, calling patients, and visit status
- Patient visit search, queue reports, and recent activity log
- Built-in queue assistant, with optional OpenAI API integration

## Run locally

Requires Node.js 18 or newer.

```powershell
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) for patients or [http://localhost:3000/admin.html](http://localhost:3000/admin.html) for staff.

For local demonstrations, the staff password defaults to `staff123`. Set a stronger password before sharing the app:

```powershell
$env:STAFF_PASSWORD = "choose-a-strong-password"
npm start
```

The queue and account data are stored locally in `data.json`. That file and `node_modules` are intentionally excluded from Git.

## Important limitations

This is a queue-management demo, not a production EHR or clinical system. Patient records, lab results, medications, appointments, billing, staff accounts, and profiles are not implemented. Data is stored in a local JSON file, which is not suitable for concurrent or production use. Do not enter real patient or clinical information; production use requires a security, privacy, backup, and regulatory review.
