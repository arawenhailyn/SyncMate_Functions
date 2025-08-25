"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatbotService = void 0;
exports.useChatbotService = useChatbotService;
// src/lib/chatbot-service.ts
const supabase_1 = require("@/lib/supabase");
const gemini_1 = require("@/lib/gemini");
const react_1 = require("react");
class ChatbotService {
    context = null;
    constructor() { }
    async initializeContext(userId, userRole) {
        // Fetch current compliance issues
        let issuesQuery = supabase_1.supabase
            .from('compliance_issues')
            .select('*')
            .order('date_created', { ascending: false })
            .limit(50);
        // Apply role-based filtering
        if (userRole !== 'dataTeamLead' && userRole !== 'teamLead') {
            issuesQuery = issuesQuery.eq('assignee', userId);
        }
        const { data: issues } = await issuesQuery;
        // Fetch recent audit activity
        const { data: activity } = await supabase_1.supabase
            .from('audit_events')
            .select('*')
            .eq('firebase_uid', userId)
            .order('created_at', { ascending: false })
            .limit(20);
        this.context = {
            userId,
            userRole,
            currentIssues: issues || [],
            recentActivity: activity || []
        };
    }
    async processMessage(message) {
        const lowerMessage = message.toLowerCase();
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        try {
            if (this.isComplianceQuery(lowerMessage)) {
                return await this.handleComplianceQuery(message, timestamp);
            }
            if (this.isGlossaryQuery(lowerMessage)) {
                return await this.handleGlossaryQuery(message, timestamp);
            }
            if (this.isResolutionQuery(lowerMessage)) {
                return await this.handleResolutionQuery(message, timestamp);
            }
            if (this.isDashboardQuery(lowerMessage)) {
                return await this.handleDashboardQuery(message, timestamp);
            }
            // Default to AI-powered response
            return await this.generateAIResponse(message, timestamp);
        }
        catch (error) {
            console.error('Error processing message:', error);
            return {
                id: crypto.randomUUID(),
                content: "I'm sorry, I encountered an error processing your request. Please try again.",
                isBot: true,
                timestamp,
                type: 'text'
            };
        }
    }
    isComplianceQuery(message) {
        const complianceKeywords = ['comp-', 'issue', 'compliance', 'violation', 'duplicate', 'threshold', 'policy'];
        return complianceKeywords.some(keyword => message.includes(keyword));
    }
    isGlossaryQuery(message) {
        const glossaryKeywords = ['definition', 'what is', 'explain', 'define', 'meaning', 'glossary', 'term'];
        return glossaryKeywords.some(keyword => message.includes(keyword));
    }
    isResolutionQuery(message) {
        const resolutionKeywords = ['resolve', 'fix', 'solution', 'how to', 'workflow', 'process', 'steps'];
        return resolutionKeywords.some(keyword => message.includes(keyword));
    }
    isDashboardQuery(message) {
        const dashboardKeywords = ['dashboard', 'stats', 'metrics', 'kpi', 'performance', 'activity', 'summary'];
        return dashboardKeywords.some(keyword => message.includes(keyword));
    }
    async handleComplianceQuery(message, timestamp) {
        const lowerMessage = message.toLowerCase();
        // Check for specific issue ID
        const issueIdMatch = message.match(/comp-\d+/i);
        if (issueIdMatch && this.context) {
            const issueId = issueIdMatch[0].toUpperCase();
            const issue = this.context.currentIssues.find(i => i.issue_id === issueId);
            if (issue) {
                return {
                    id: crypto.randomUUID(),
                    content: this.renderIssueDetails(issue),
                    isBot: true,
                    timestamp,
                    type: 'component',
                    metadata: { issueId: issue.issue_id }
                };
            }
        }
        // General compliance queries
        if (lowerMessage.includes('duplicate')) {
            const duplicateIssues = this.context?.currentIssues.filter(i => i.issue_type?.toLowerCase().includes('duplicate')) || [];
            return {
                id: crypto.randomUUID(),
                content: this.renderDuplicateIssuesSummary(duplicateIssues),
                isBot: true,
                timestamp,
                type: 'component'
            };
        }
        // Fallback to AI response for complex queries
        return await this.generateAIResponse(message, timestamp);
    }
    async handleGlossaryQuery(message, timestamp) {
        const terms = await this.searchGlossaryTerms(message);
        if (terms.length > 0) {
            const bestMatch = terms[0];
            return {
                id: crypto.randomUUID(),
                content: this.renderGlossaryTerm(bestMatch),
                isBot: true,
                timestamp,
                type: 'component',
                metadata: { termId: bestMatch.id }
            };
        }
        return {
            id: crypto.randomUUID(),
            content: "I couldn't find any matching terms in the data glossary. Could you be more specific about what you'd like to know?",
            isBot: true,
            timestamp,
            type: 'text'
        };
    }
    async handleResolutionQuery(message, timestamp) {
        const issueIdMatch = message.match(/comp-\d+/i);
        if (issueIdMatch && this.context) {
            const issueId = issueIdMatch[0].toUpperCase();
            const issue = this.context.currentIssues.find(i => i.issue_id === issueId);
            if (issue) {
                return {
                    id: crypto.randomUUID(),
                    content: this.renderResolutionSteps(issue),
                    isBot: true,
                    timestamp,
                    type: 'component',
                    metadata: { issueId: issue.issue_id, action: 'resolution' }
                };
            }
        }
        // General resolution workflow
        return {
            id: crypto.randomUUID(),
            content: this.renderGeneralResolutionWorkflow(),
            isBot: true,
            timestamp,
            type: 'component'
        };
    }
    async handleDashboardQuery(_message, timestamp) {
        if (!this.context) {
            return {
                id: crypto.randomUUID(),
                content: 'I need to initialize my context first. Please refresh and try again.',
                isBot: true,
                timestamp,
                type: 'text'
            };
        }
        const stats = {
            totalIssues: this.context.currentIssues.length,
            openIssues: this.context.currentIssues.filter(i => i.status === 'Open').length,
            inProgressIssues: this.context.currentIssues.filter(i => i.status === 'In Progress').length,
            resolvedIssues: this.context.currentIssues.filter(i => i.status === 'Closed').length,
            highSeverity: this.context.currentIssues.filter(i => i.severity?.toLowerCase().includes('high')).length,
            recentActivity: this.context.recentActivity.length
        };
        return {
            id: crypto.randomUUID(),
            content: this.renderDashboardStats(stats),
            isBot: true,
            timestamp,
            type: 'component'
        };
    }
    async generateAIResponse(message, timestamp) {
        try {
            const model = (0, gemini_1.getGeminiModel)();
            if (!model) {
                return this.getFallbackResponse(message, timestamp);
            }
            // Keep for future: const contextData = this.buildAIContext()
            const prompt = `
        You are SyncMate AI, a compliance and data governance assistant. 
        
        Context about current user:
        - Role: ${this.context?.userRole || 'Unknown'}
        - Active Issues: ${this.context?.currentIssues.length || 0}
        - Recent Activity: ${this.context?.recentActivity.length || 0}
        
        User message: "${message}"
        
        Provide a helpful, concise response. If the user is asking about specific compliance issues, data terms, or workflows, be specific and actionable. Keep responses under 200 words.
      `;
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            return {
                id: crypto.randomUUID(),
                content: text,
                isBot: true,
                timestamp,
                type: 'text'
            };
        }
        catch (error) {
            console.error('AI generation failed:', error);
            return this.getFallbackResponse(message, timestamp);
        }
    }
    getFallbackResponse(_message, timestamp) {
        const fallbacks = [
            'I can help you with compliance issues, data definitions, and resolution workflows. Try asking about specific issues or terms.',
            'Let me know if you need help understanding any compliance issues or data terms in your dashboard.',
            "I'm here to assist with your compliance and data governance questions. What would you like to know more about?"
        ];
        return {
            id: crypto.randomUUID(),
            content: fallbacks[Math.floor(Math.random() * fallbacks.length)],
            isBot: true,
            timestamp,
            type: 'text'
        };
    }
    async searchGlossaryTerms(query) {
        const { data, error } = await supabase_1.supabase
            .from('data_glossary')
            .select('*')
            .or(`term.ilike.%${query}%,definition.ilike.%${query}%,tags.cs.{${query}}`)
            .limit(5);
        if (error) {
            console.error('Glossary search error:', error);
            return [];
        }
        return data || [];
    }
    buildAIContext() {
        if (!this.context)
            return '';
        const issuesSummary = this.context.currentIssues
            .slice(0, 5)
            .map(issue => `${issue.issue_id}: ${issue.issue_type} (${issue.status})`)
            .join(', ');
        return `Current issues: ${issuesSummary}`;
    }
    // Rendering methods return strings (OK for dangerouslySetInnerHTML or a renderer)
    renderIssueDetails(issue) {
        return `
      <div class="space-y-2">
        <div class="bg-white border rounded-lg p-3">
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-medium">${issue.issue_id}: ${issue.issue_type}</h3>
            <span class="px-2 py-1 ${issue.status === 'Open' ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800'} rounded text-xs">
              ${issue.status}
            </span>
          </div>
          <p class="text-sm text-gray-600">Entity: ${issue.entity ?? ''}</p>
          <p class="text-sm text-gray-600">Severity: ${issue.severity ?? ''}</p>
          <p class="text-sm text-gray-600">Created: ${issue.date_created ? new Date(issue.date_created).toLocaleDateString() : ''}</p>
          ${issue.description ? `<p class="text-sm mt-2">${issue.description}</p>` : ''}
        </div>
        <p class="text-sm">Would you like me to help you resolve this issue or explain the resolution process?</p>
      </div>
    `;
    }
    renderDuplicateIssuesSummary(issues) {
        return `
      I found ${issues.length} duplicate record issues:
      ${issues.map(issue => `• ${issue.issue_id} (${issue.entity ?? ''}) - ${issue.status}`).join('<br/>')}
      <br/><br/>
      Duplicate records occur when the same entity exists multiple times with different identifiers. Would you like help resolving any of these specific issues?
    `;
    }
    renderGlossaryTerm(term) {
        // examples can be: stringified JSON array, a plain string, an array, or null
        const example = (() => {
            const ex = term.examples;
            if (!ex)
                return '';
            if (Array.isArray(ex))
                return ex[0] ?? '';
            if (typeof ex === 'string') {
                // try to parse JSON array; if not JSON, use the string as-is
                try {
                    const parsed = JSON.parse(ex);
                    return Array.isArray(parsed) ? (parsed[0] ?? '') : ex;
                }
                catch {
                    return ex;
                }
            }
            return '';
        })();
        const idAttr = term.id != null ? ` data-term-id="${String(term.id)}"` : '';
        return `
    <div class="bg-white border rounded-lg p-3 space-y-2">
      <div class="flex items-center justify-between">
        <h3 class="font-medium">${term.term ?? ''}</h3>
        <span class="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs">${term.category ?? ''}</span>
      </div>
      <p class="text-sm text-gray-700">${term.definition ?? ''}</p>
      ${example ? `<div><p class="text-xs font-medium text-gray-600">Example:</p><p class="text-xs text-gray-600 italic">"${example}"</p></div>` : ''}
      <button class="text-xs bg-blue-50 hover:bg-blue-100 text-blue-600 px-2 py-1 rounded"${idAttr}>
        View Full Definition
      </button>
    </div>
  `;
    }
    renderResolutionSteps(issue) {
        const steps = this.getResolutionStepsForIssueType(issue.issue_type || '');
        return `
      Resolution workflow for ${issue.issue_id}:<br/><br/>
      ${steps.map((step, index) => `${index + 1}. ${step}`).join('<br/>')}
      <br/><br/>
      Current status: ${issue.status}<br/><br/>
      Would you like me to guide you through any of these steps?
    `;
    }
    renderGeneralResolutionWorkflow() {
        return `
      <strong>Standard Issue Resolution Workflow:</strong><br/><br/>
      1. <b>Analysis</b> - Review issue details and impact<br/>
      2. <b>Action Selection</b> - Choose appropriate resolution method<br/>
      3. <b>Execution</b> - Implement the chosen solution<br/>
      4. <b>Verification</b> - Confirm the issue is resolved<br/>
      5. <b>Documentation</b> - Record resolution details<br/><br/>
      Each step includes validation checkpoints and can be customized based on issue type and severity.
    `;
    }
    renderDashboardStats(stats) {
        return `
      📊 <strong>Your Dashboard Summary:</strong><br/><br/>
      • Total Issues: ${stats.totalIssues}<br/>
      • Open: ${stats.openIssues} | In Progress: ${stats.inProgressIssues} | Resolved: ${stats.resolvedIssues}<br/>
      • High Severity: ${stats.highSeverity}<br/>
      • Recent Activity: ${stats.recentActivity} events<br/><br/>
      ${stats.openIssues > 0
            ? `You have ${stats.openIssues} issues that need attention. Would you like me to help prioritize them?`
            : 'Great job! No open issues at the moment.'}
    `;
    }
    getResolutionStepsForIssueType(issueType) {
        const type = issueType.toLowerCase();
        if (type.includes('duplicate')) {
            return [
                'Identify all duplicate records using matching criteria',
                'Determine the master record to keep',
                'Merge or consolidate data from duplicates',
                'Update references and relationships',
                'Remove or archive duplicate entries',
                'Implement prevention measures'
            ];
        }
        if (type.includes('threshold')) {
            return [
                'Review current threshold settings',
                'Analyze business impact of violation',
                'Determine appropriate threshold adjustment',
                'Update system configuration',
                'Test new threshold behavior',
                'Monitor for future violations'
            ];
        }
        if (type.includes('policy')) {
            return [
                'Review policy requirements',
                'Assess current implementation gaps',
                'Design compliance solution',
                'Implement policy controls',
                'Validate compliance status',
                'Document policy adherence'
            ];
        }
        return [
            'Analyze issue details and root cause',
            'Develop resolution strategy',
            'Implement corrective actions',
            'Verify resolution effectiveness',
            'Update documentation',
            'Monitor for recurrence'
        ];
    }
}
exports.ChatbotService = ChatbotService;
function useChatbotService() {
    const [service] = (0, react_1.useState)(() => new ChatbotService());
    const initializeService = async (userId, userRole) => {
        await service.initializeContext(userId, userRole);
    };
    const sendMessage = async (message) => {
        return await service.processMessage(message);
    };
    return { initializeService, sendMessage };
}
