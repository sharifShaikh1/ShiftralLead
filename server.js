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
  keyFile: path.join(__dirname, 'shiftraa-moving-credentials.json'),
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
                endRowIndex: 2,   // Insert one row
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
      range: `Sheet1!A2:S2`, // helps to insert data at row 2
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
      range: `Sheet1!A${rowIndex}:S${rowIndex}`,
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
app.post('/submit-quote', async (req, res) => {
  console.log('Received form submission:', req.body);
  try {
    const { data, part } = req.body;
    if (!data || !part) {
      console.log('Missing data or part in request body');
      return res.status(400).json({ message: 'Missing data or part in request body' });
    }

    // Validate part
    if (!['1', '2'].includes(part)) {
      console.log('Invalid form part:', part);
      return res.status(400).json({ message: 'Invalid form part' });
    }

    // Validate required fields for Part 1
    const {
      name,
      phone_country_code,
      phone_number,
      email,
      move_scope,
      home_type_details,
      vehicle_selection,
      moving_date,
      requirements,
      current_address,
      new_address,
      current_city,
      new_city,
      current_country,
      from_city_international,
      new_country,
      to_city_international,
      estimated_cost = 'N/A',
    } = data;

    if (!name || !phone_country_code || !phone_number || !move_scope || !moving_date) {
      console.log('Missing required fields for submission');
      return res.status(400).json({ message: 'Missing required fields: name, phone_country_code, phone_number, move_scope, and moving_date are required' });
    }

    // Get UUID from cookie or generate new one
    let uuid = req.cookies.shiftraa_uuid || uuidv4();
    let submissionPart = part;

    console.log('Determined form part:', { uuid, part: submissionPart, email });

    // Prepare data array for Google Sheet (19 columns)
    let sheetData = [
      uuid,
      new Date().toISOString(),
      name || '',
      `${phone_country_code}${phone_number}`,
      email || 'Not Provided',
      move_scope || '',
      home_type_details || '',
      vehicle_selection || '',
      moving_date || '',
      requirements || '',
      current_address || '',
      new_address || '',
      current_city || '',
      new_city || '',
      current_country || '',
      from_city_international || '',
      new_country || '',
      to_city_international || '',
      estimated_cost || 'N/A',
    ];

    console.log('Prepared sheetData:', sheetData);

    // Prepare email body for owner
    let emailToOwnerBody = `
      <h2>Shiftraa Moving - New Quote Submission (Part ${submissionPart})</h2>
      <p><strong>UUID:</strong> ${uuid}</p>
      <p><strong>Name:</strong> ${sheetData[2]}</p>
      <p><strong>Phone:</strong> ${sheetData[3]}</p>
      <p><strong>Email:</strong> ${sheetData[4]}</p>
      <p><strong>Move Scope:</strong> ${sheetData[5]}</p>
      <p><strong>Home Type:</strong> ${sheetData[6]}</p>
      <p><strong>Vehicle:</strong> ${sheetData[7]}</p>
      <p><strong>Moving Date:</strong> ${sheetData[8]}</p>
      <p><strong>Requirements:</strong> ${sheetData[9]}</p>
    `;
    if (submissionPart === '2') {
      if (move_scope === 'Local') {
        emailToOwnerBody += `
          <p><strong>Current Address:</strong> ${sheetData[10]}</p>
          <p><strong>New Address:</strong> ${sheetData[11]}</p>
        `;
      } else if (move_scope === 'Domestic') {
        emailToOwnerBody += `
          <p><strong>Current City:</strong> ${sheetData[12]}</p>
          <p><strong>New City:</strong> ${sheetData[13]}</p>
        `;
      } else if (move_scope === 'International') {
        emailToOwnerBody += `
          <p><strong>Current Country:</strong> ${sheetData[15]}</p>
          <p><strong>From City:</strong> ${sheetData[16]}</p>
          <p><strong>New Country:</strong> ${sheetData[17]}</p>
          <p><strong>To City:</strong> ${sheetData[18]}</p>
        `;
      }
    }

    console.log('Prepared owner email body:', emailToOwnerBody);

    // Check if row exists for UUID
    const rowIndex = await findRowByUUID(uuid);
    if (rowIndex) {
      // Update existing row
      console.log(`Row found at index ${rowIndex}, fetching existing data`);
      const existingRow = (await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `Sheet1!A${rowIndex}:S${rowIndex}`,
      })).data.values[0];

      console.log('Existing row data:', existingRow);

      sheetData = [
        uuid,
        existingRow[1], // Preserve original timestamp
        name || existingRow[2] || '',
        `${phone_country_code}${phone_number}` || existingRow[3] || '',
        email || existingRow[4] || 'Not Provided',
        move_scope || existingRow[5] || '',
        home_type_details || existingRow[6] || '',
        vehicle_selection || existingRow[7] || '',
        moving_date || existingRow[8] || '',
        requirements || existingRow[9] || '',
        current_address || existingRow[10] || '',
        new_address || existingRow[11] || '',
        current_city || existingRow[12] || '',
        new_city || existingRow[13] || '',
        current_country || existingRow[14] || '',
        from_city_international || existingRow[15] || '',
        new_country || existingRow[16] || '',
        to_city_international || existingRow[17] || '',
        estimated_cost || existingRow[18] || '',
      ];

      console.log('Updated sheetData for existing row:', sheetData);

      await updateRow(rowIndex, sheetData);
    } else {
      // Append new row
      console.log('No existing row found, appending new row');
      await appendToSheet(sheetData);
      // Set UUID cookie for Part 1
      if (submissionPart === '1') {
        console.log('Setting UUID cookie for Part 1:', uuid);
        res.cookie('shiftraa_uuid', uuid, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        });
      }
    }

    // Send email to owner for both Part 1 and Part 2
    try {
      console.log('Sending owner notification email');
      await sendEmail(
        ownerEmail,
        `New Quote Submission - Part ${submissionPart}`,
        emailToOwnerBody
      );
    } catch (emailError) {
      console.error('Failed to send email to owner, but continuing with response:', emailError.message);
      // Do not fail the request if email sending fails
    }

    // Send confirmation email to user only for Part 2
    if (submissionPart === '2' && email && email !== 'Not Provided') {
      try {
        console.log('Sending user confirmation email to:', email);
        await sendEmail(
          email,
          'Thank You for Your Shiftraa Moving Quote Request',
          `
            <h2>Thank You for Choosing Shiftraa Moving!</h2>
            <p>Dear ${name || 'Customer'},</p>
            <p>We have received your detailed quote request. Our team will reach out to you shortly to discuss your move.</p>
            <p><strong>Summary:</strong></p>
            <p>Move Type: ${move_scope}</p>
            <p>Moving Date: ${moving_date}</p>
            <p>Contact: ${phone_country_code}${phone_number}</p>
            <p>Best regards,<br>Shiftraa Moving Team<br>${senderEmail}</p>
          `
        );
        // Clear UUID cookie after Part 2
        console.log('Clearing UUID cookie after Part 2');
        res.clearCookie('shiftraa_uuid');
      } catch (userEmailError) {
        console.error('Failed to send email to user, but continuing with response:', userEmailError.message);
  
      }
    }

    console.log(`Form submission processed successfully: Part ${submissionPart}`);
    res.status(200).json({
      uuid,
      message: `Part ${submissionPart} submitted successfully`,
      success: true,
    });
  } catch (error) {
    console.error('Error processing submission:', error.message);
    res.status(500).json({ message: 'Error submitting quote', error: error.message });
  }
});


app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});