const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const { SendMailClient } = require('zeptomail');
const cookieParser = require('cookie-parser');
const axios = require('axios');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const allowedOrigins=[
process.env.FRONTEND_URL,

].filter(Boolean);
app.use(cors({
origin : (origin, callback)=>{
if (!origin || allowedOrigins.includes(origin)){
callback(null, true);
}
else{
callback(new Error('Not allowed by CORS'));
}
},
credentials: true,
}))
// ZeptoMail setup
const zeptoUrl = process.env.ZEPTO_URL;
const zeptoToken = process.env.ZEPTO_TOKEN;
const zeptoClient = new SendMailClient({ url: zeptoUrl, token: zeptoToken });
const ownerEmail = process.env.OWNER_EMAIL;
const senderEmail = process.env.SENDER_EMAIL;

// Middleware

app.use(express.json());
app.use(cookieParser());

// Google Sheets setup
const auth = new google.auth.GoogleAuth({
credentials:JSON.parse(process.env.GOOGLE_CREDENTIALS),
scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = process.env.GOOGLE_SHEET_ID;

// Helper: Find row by UUID in Google Sheet
async function findRowByUUID(uuid) {
try {
console.log(`Finding row with UUID: ${uuid}`);
const response = await sheets.spreadsheets.values.get({
spreadsheetId,
range: 'Sheet1!A2:A',
});
const rows = response.data.values || [];
const rowIndex = rows.findIndex(row => row[0] === uuid);
console.log(`Row index found: ${rowIndex >= 0 ? rowIndex + 2 : 'Not found'}`);
return rowIndex >= 0 ? rowIndex + 2 : null;
} catch (error) {
console.error(`Error finding row by UUID: ${error.message}`);
throw new Error(`Failed to find row by UUID: ${error.message}`);
}
}

// Helper: Prepend new row to Google Sheet (insert at the top below header)
async function appendToSheet(data) {
try {
console.log(`Prepending data to Google Sheet: ${JSON.stringify(data)}`);

// Step 1: Get the sheet's metadata to determine the sheet ID
const sheetMetadata = await sheets.spreadsheets.get({
spreadsheetId,
ranges: 'Sheet1',
fields: 'sheets(properties(sheetId))',
});
const sheetId = sheetMetadata.data.sheets[0].properties.sheetId;
console.log(`Sheet ID retrieved: ${sheetId}`);

// Step 2: Insert a new row at the top (just below the header row at row 1)
await sheets.spreadsheets.batchUpdate({
spreadsheetId,
resource: {
requests: [
{
insertRange: {
range: {
sheetId: sheetId,
startRowIndex: 1, // Insert after the header row (row 1)
endRowIndex: 2, // Insert one row
startColumnIndex: 0,
endColumnIndex: data.length, // Match the number of columns in the data
},
shiftDimension: 'ROWS',
},
},
],
},
});
console.log('New row inserted at row 2');

// Step 3: Write the new data into the newly inserted row (row 2)
await sheets.spreadsheets.values.update({
spreadsheetId,
range: `Sheet1!A2:T2`, // helps to insert data at row 2
valueInputOption: 'RAW',
resource: { values: [data] },
});
console.log('Data successfully prepended to Google Sheet at row 2');
} catch (error) {
console.error(`Error prepending to sheet: ${error.message}`);
throw new Error(`Failed to prepend to sheet: ${error.message}`);
}
}

async function updateRow(rowIndex, data) {
try {
console.log(`Updating row ${rowIndex} with data: ${JSON.stringify(data)}`);
await sheets.spreadsheets.values.update({
spreadsheetId,
range: `Sheet1!A${rowIndex}:T${rowIndex}`,
valueInputOption: 'RAW',
resource: { values: [data] },
});
console.log(`Row ${rowIndex} successfully updated`);
} catch (error) {
console.error(`Error updating row: ${error.message}`);
throw new Error(`Failed to update row: ${error.message}`);
}
}

// Helper: Send email via ZeptoMail
async function sendEmail(to, subject, body) {
try {
console.log(`Sending email to ${to} with subject: ${subject}`);
await zeptoClient.sendMail({
from: { address: senderEmail, name: 'Shiftraa Moving' },
to: [{ email_address: { address: to, name: '' } }],
subject,
htmlbody: body,
});
console.log(`Email successfully sent to ${to}`);
} catch (error) {
console.error(`Error sending email to ${to}: ${error.message}`);
throw new Error(`Failed to send email to ${to}: ${error.message}`);
}
}

// Serve index.html for the root route

app.get('/google-maps-api', async (req, res) => {
try {
const apiKey = process.env.GOOGLE_MAPS_API_KEY;
if (!apiKey) {
return res.status(500).json({ error: 'API key not configured on the server' });
}

const googleMapsUrl = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,core&callback=onGoogleMapsApiLoaded&loading=async`;
const response = await axios.get(googleMapsUrl, { responseType: 'text' });

res.set('Content-Type', 'application/javascript');
res.send(response.data);
} catch (error) {
console.error('Error fetching Google Maps API script:', error.message);
res.status(500).json({ error: 'Failed to load Google Maps API script' });
}
});
// POST endpoint to handle form submission
// In server.js

app.post('/submit-quote', async (req, res) => {
    console.log('Received form submission for part:', req.body.part);
    try {
        const { data, part } = req.body;
        if (!data || !part || !['1', '2'].includes(part)) {
            return res.status(400).json({ message: 'Missing or invalid data/part in request' });
        }
        
        // FIX: This is the single source of truth for the session.
        // It reads the cookie sent by the browser. If it doesn't exist, it creates a new one.
        let uuid = req.cookies.shiftraa_uuid || uuidv4();
        console.log(`Processing request with UUID: ${uuid}`);

        // This defines the exact order of columns in your Google Sheet.
        const sheetColumns = [
            'uuid', 'timestamp', 'name', 'phone', 'email', 'move_scope', 
            'home_type_details', 'vehicle_selection', 'moving_date', 'requirements', 
            'current_address', 'new_address', 'current_city', 'new_city', 
            'current_country', 'from_city_international', 'new_country', 
            'to_city_international', 'estimated_cost', 'distance'
        ];

        let finalData = {};
        const rowIndex = await findRowByUUID(uuid);

        if (part === '2' && rowIndex) {
            console.log(`Part 2: Found existing row at index ${rowIndex}. Merging data.`);
            const existingRowValues = (await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `Sheet1!A${rowIndex}:${String.fromCharCode(65 + sheetColumns.length - 1)}${rowIndex}`,
            })).data.values[0];

            let existingData = {};
            sheetColumns.forEach((col, i) => {
                existingData[col] = existingRowValues[i] || '';
            });
            
            // FIX: Correctly merge new data over existing data.
            finalData = { ...existingData, ...data, uuid: uuid };

        } else {
            console.log(`Part 1 (or new session): Preparing new data.`);
            finalData = { ...data, uuid: uuid, timestamp: new Date().toISOString() };
        }
        
        // Map the final data object to an array in the correct column order.
        const sheetData = sheetColumns.map(colName => {
// Special handling for the combined phone number field
if (colName === 'phone' && finalData.phone_country_code && finalData.phone_number) {
return `${finalData.phone_country_code}${finalData.phone_number}`;
}
return finalData[colName] || '';
});

        console.log('Final data for sheet:', sheetData);
        
        if (part === '2' && rowIndex) {
            await updateRow(rowIndex, sheetData);
        } else {
            await appendToSheet(sheetData);
        }
        
        // Set the cookie on Part 1 to track the user for Part 2.
        if (part === '1') {
            res.cookie('shiftraa_uuid', uuid, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                // FIX: This is required for cross-domain cookies to work.
                sameSite: 'None',
                maxAge: 24 * 60 * 60 * 1000, // 1 day
                path: '/'
            });
        }
        
        // Clear the cookie after the final step (Part 2) is completed.
        if (part === '2') {
             res.clearCookie('shiftraa_uuid', { path: '/' });
        }
        
        // ... your email sending logic remains the same ...

        res.status(200).json({
            uuid,
       message: `Part ${part} submitted successfully`,
          success: true,
        });

    } catch (error) {
        console.error('Error processing submission:', error.message, error.stack);
        res.status(500).json({ message: 'Error submitting quote', error: error.message });
    }
});


app.listen(port, () => {
console.log(`Server running at http://localhost:${port}`);
});