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
npm ci
npm start
```

Open [http://localhost:3000](http://localhost:3000) for patients or [http://localhost:3000/admin.html](http://localhost:3000/admin.html) for staff.

For local demonstrations, the staff password defaults to `staff123`. Set a stronger password before sharing the app:

```powershell
$env:STAFF_PASSWORD = "choose-a-strong-password"
npm start
```

The queue and account data are stored locally in `data.json`. That file and `node_modules` are intentionally excluded from Git.

## Run without internet (Windows / VS Code)

The app itself runs on your computer. Its pages, styles, scripts, queue data, and built-in assistant are local; no internet connection is needed while using it. The optional OpenAI assistant does need internet, but is not required.

1. Install Node.js 18 or newer while you have access to the installer. In VS Code, choose **File > Open Folder** and open this project folder.
2. Open **Terminal > New Terminal**. Check that Node.js and npm are available:

   ```powershell
   node --version
   npm --version
   ```

3. Install the project packages before going offline. In the terminal, make sure the current directory is this project, then run:

   ```powershell
   npm ci
   ```

   If `node_modules` is already present, you can skip this step. If you are already offline and it is missing, `npm ci` can only work if the required packages are already in your npm cache; otherwise, copy the project with its `node_modules` folder from a computer where `npm ci` completed, or install dependencies once while online.
4. Start the server:

   ```powershell
   npm start
   ```

5. Keep that terminal open and visit `http://localhost:3000` for the patient page or `http://localhost:3000/admin.html` for the staff page. Do not open the HTML files by double-clicking them.
6. To stop the server, focus the terminal and press **Ctrl+C**.

The built-in queue assistant works offline. If `OPENAI_API_KEY` is configured, patient assistant messages may try the online OpenAI service and fall back to the built-in assistant if it cannot connect. To ensure no OpenAI requests are attempted in the current PowerShell terminal, run this before `npm start`:

```powershell
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
npm start
```

## Important limitations

This is a queue-management demo, not a production EHR or clinical system. Patient records, lab results, medications, appointments, billing, staff accounts, and profiles are not implemented. Data is stored in a local JSON file, which is not suitable for concurrent or production use. Do not enter real patient or clinical information; production use requires a security, privacy, backup, and regulatory review.
