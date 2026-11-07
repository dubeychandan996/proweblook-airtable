import React from 'react';
import { initializeBlock } from '@airtable/blocks/ui';
import { ProWebLookAirtableApp } from './App.js';

initializeBlock(() => React.createElement(ProWebLookAirtableApp));
