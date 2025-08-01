import { filesDB, usersDB } from '../../../utils/database.js';
import { verifyToken, getTokenFromRequest } from '../../../utils/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify authentication
    const token = getTokenFromRequest(req);
    const decoded = verifyToken(token);
    
    if (!decoded) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Find user using file-based database (since MongoDB connection doesn't exist)
    const user = usersDB.findByEmail(decoded.email);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    // Get userId for file operations
    const userId = user.id;

    const { fileId } = req.body;
    
    if (!fileId) {
      return res.status(400).json({ error: 'File ID is required' });
    }

    // Get the file
    const file = filesDB.findById(fileId);
    
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    if (file.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to update this file' });
    }
    
    if (!file.transcript) {
      return res.status(400).json({ error: 'File has no transcript to summarize' });
    }

    // Check if API key is available
    if (!process.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not configured');
      return res.status(500).json({ error: 'AI service not configured. Please set up GEMINI_API_KEY.' });
    }

    // Generate new summary
    try {
      console.log(`Regenerating summary for file ${file.id}...`);
      const newSummary = await generateSummary(file.transcript);
      
      if (!newSummary || newSummary.includes('failed')) {
        console.error('Summary generation returned invalid result:', newSummary);
        return res.status(500).json({ error: 'AI summary generation failed. Please try again.' });
      }
      
      // Update file
      const updatedFile = filesDB.update(file.id, {
        summary: newSummary,
        topic: file.topic || 'General' // Preserve existing topic if available
      });
      
      if (!updatedFile) {
        console.error('Failed to update file in database');
        return res.status(500).json({ error: 'Failed to save updated summary' });
      }

      console.log(`Successfully regenerated summary for file ${file.id}`);
      return res.status(200).json({
        success: true,
        message: 'Summary regenerated successfully',
        summary: newSummary
      });
    } catch (err) {
      console.error(`Error processing file ${file.id}:`, err);
      return res.status(500).json({ 
        error: 'Failed to regenerate summary', 
        details: err.message 
      });
    }

  } catch (error) {
    console.error('Error regenerating summary:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function generateSummary(text) {
  try {
    console.log('Starting summary generation...');
    
    // Validate input
    if (!text || text.trim().length === 0) {
      throw new Error('No transcript text provided');
    }
    
    // Take a subset of the transcript if it's too long (matching working TypeScript code)
    const maxTranscriptLength = 32000;
    const truncatedText = text.length > maxTranscriptLength 
      ? text.substring(0, maxTranscriptLength) 
      : text;
    
    console.log(`Processing transcript of ${truncatedText.length} characters`);
    
    // Using the exact same prompt format as the working TypeScript code
    const summaryPrompt = `Analyze this transcript:\n\n"${truncatedText}"\n\nProvide:\n1. SUMMARY: A 2-3 sentence summary.\n2. TOPICS: 3-5 main topics, comma-separated.\n3. INSIGHTS: 1-2 key insights.\n\nFormat your response exactly like this:\nSUMMARY: [Your summary]\nTOPICS: [topic1, topic2]\nINSIGHTS: [Your insights]`;
    
    // Using the same model as the working code (gemini-1.5-flash)
    console.log('Making API request to Gemini...');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: summaryPrompt
          }]
        }]
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', response.status, response.statusText);
      console.error('Error response:', errorText);
      
      if (response.status === 401) {
        throw new Error('Invalid API key - please check GEMINI_API_KEY configuration');
      } else if (response.status === 403) {
        throw new Error('API access forbidden - please check API key permissions');
      } else if (response.status === 429) {
        throw new Error('API rate limit exceeded - please try again later');
      } else {
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
      }
    }

    const data = await response.json();
    console.log('Received API response:', JSON.stringify(data, null, 2));
    
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    if (!generatedText) {
      console.error('No generated text in API response');
      throw new Error('Empty response from AI service');
    }
    
    console.log('Generated text:', generatedText);
    
    // Parse response using the exact same logic as working code
    let summary = "AI-generated summary not available";
    
    const summaryMatch = generatedText.match(/SUMMARY:\s*(.+?)(?=TOPICS:|$)/s);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
      console.log('Extracted summary:', summary);
    } else {
      console.error('Could not extract summary from generated text');
    }
    
    // Validate the summary
    if (!summary || summary.length < 20) {
      console.error('Summary too short or invalid:', summary);
      throw new Error('Generated summary is too short or invalid');
    }
    
    console.log('Summary generation completed successfully');
    return summary;
  } catch (error) {
    console.error('Summary generation error:', error.message);
    throw error; // Re-throw to be handled by the calling function
  }
}

async function generateSummaryRetry(text) {
  try {
    // Simplified retry using the same working pattern
    const summaryPrompt = `Analyze this transcript:\n\n"${text}"\n\nProvide:\n1. SUMMARY: A 2-3 sentence summary.\n2. TOPICS: 3-5 main topics, comma-separated.\n3. INSIGHTS: 1-2 key insights.\n\nFormat your response exactly like this:\nSUMMARY: [Your summary]\nTOPICS: [topic1, topic2]\nINSIGHTS: [Your insights]`;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: summaryPrompt
          }]
        }]
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API retry error:', response.status, response.statusText);
      console.error('Error response:', errorText);
      throw new Error(`Gemini API retry error: ${response.status}`);
    }

    const data = await response.json();
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // Parse response
    const summaryMatch = generatedText.match(/SUMMARY:\s*(.+?)(?=TOPICS:|$)/s);
    let summary = summaryMatch ? summaryMatch[1].trim() : "AI summary generation failed after retry";
    
    if (!summary || summary.length < 20) {
      return "AI summary generation failed after retry - please regenerate manually.";
    }
    
    return summary;
  } catch (error) {
    console.error('Retry summary generation error:', error);
    return 'AI summary generation failed after retry';
  }
}
