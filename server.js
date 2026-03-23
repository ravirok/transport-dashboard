const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 4000;

// Demo /api/transports route
app.get('/api/transports', (req, res) => {
  const data = {
    d: {
      results: [
        { Transport: 'TR001', Description: 'Demo Transport 1', Status: 'Failed', RiskScore: 0.8,
          FailedObjects: [{ObjectName:'OBJ1',Type:'ABAP Program',Error:'Syntax Error'},{ObjectName:'OBJ2',Type:'Function Module',Error:'Dependency Missing'}],
          Logs: ['2026-03-20 10:15:12 - OBJ1 failed','2026-03-20 10:15:15 - OBJ2 dependency missing']
        },
        { Transport: 'TR002', Description: 'Demo Transport 2', Status: 'Success', RiskScore: 0.2, FailedObjects: [], Logs: [] },
        { Transport: 'TR003', Description: 'Demo Transport 3', Status: 'Failed', RiskScore: 0.6,
          FailedObjects: [{ObjectName:'OBJ3',Type:'Table',Error:'Missing Field'}], Logs: ['2026-03-20 11:00:12 - OBJ3 missing field']
        }
      ]
    }
  };
  res.json(data);
});

// Serve frontend
app.use(express.static(path.join(__dirname, 'frontend')));
app.get('*', (req,res)=>{
  res.sendFile(path.join(__dirname,'frontend/index.html'));
});

app.listen(PORT, ()=>{
  console.log(`Backend running on http://localhost:${PORT}`);
});
