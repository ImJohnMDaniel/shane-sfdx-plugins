import { flags, SfdxCommand } from '@salesforce/command';
import * as fs from 'fs-extra';

export default class CommunityJSONModify extends SfdxCommand {
    public static description = 'Manipulate community ExperienceBundle JSON files, using REST or Tooling queries to an org to get metadata IDs';
    public static examples = [
        `sfdx shane:communities:json:modify -f force-app/main/default/experiences/employeebots1/views/home.json -i 69c03077-932a-4c08-b932-46baec5a7c86 -p someProp  -v NewValue
// find the component and set a new hardcoded value for the property but don't write to the file
`,
        `sfdx shane:communities:json:modify -f force-app/main/default/experiences/employeebots1/views/home.json -i 69c03077-932a-4c08-b932-46baec5a7c86 -p orgId  -q "select id from organization" --write
// find the component and set a new value from a query to the org and update file locally
`,
        `sfdx shane:communities:json:modify -f force-app/main/default/experiences/employeebots1/views/home.json -i 69c03077-932a-4c08-b932-46baec5a7c86 -p someUnconvertedJSON -s actualPropInsideTheJSON -q "select id from organization" -t --write
// find the component and set a new value from a query onto a property contained within unconverted JSON using the tooling api and update file locally
`
    ];
    protected static supportsUsername = true;
    protected static requiresProject = true;

    protected static flagsConfig = {
        file: flags.filepath({ char: 'f', description: 'full path to the file', required: true }),
        id: flags.string({
            char: 'i',
            description: 'unique id of the component.  ex: 69c03077-932a-4c08-b932-46baec5a7c86'
        }),
        query: flags.string({
            char: 'q',
            description: 'soql query for a field to pass to the value',
            exclusive: ['value', 'variable']
        }),
        queryfield: flags.string({
            description: 'field from the record returned by --query that you want to use the value from',
            exclusive: ['value', 'variable'],
            default: 'Id'
        }),
        truncate: flags.boolean({
            description: 'truncate ids to 15 characters on queried record',
            exclusive: ['value']
        }),
        property: flags.string({
            char: 'p',
            description: 'property that will be updated (or contains JSON or what will be updated',
            required: true
        }),
        subproperty: flags.string({
            char: 's',
            description: 'if the property is a json object, or json-like string, the subproperty inside that that needs updating'
        }),
        value: flags.string({
            char: 'd',
            description: 'new value for the property/subproperty',
            exclusive: ['query', 'variable', 'truncate']
        }),
        variable: flags.string({
            description: 'assign one of the variables to the property',
            options: ['OrgId', 'InstanceUrl', 'Username'],
            exclusive: ['value', 'query', 'queryfield']
        }),
        write: flags.boolean({
            char: 'w',
            description: 'write over the original file with its new version.  omit to see what will be written'
        }),
        tooling: flags.boolean({
            char: 't',
            description: 'using tooling api for query instead of normal sobjects',
            dependsOn: ['query'],
            exclusive: ['value']
        }),
        verbose: flags.builtin()
    };

    // tslint:disable-next-line:no-any
    public async run(): Promise<any> {
        // get file
        const full = await fs.readJSON(this.flags.file);

        // find component
        if (!this.flags.value && !this.flags.query && !this.flags.variable) {
            throw new Error('either query or value or variable has to be specified');
        }

        if (this.flags.query) {
            this.flags.value = await this.query();
        }

        if (this.flags.variable) {
            this.flags.value = await this.getVariable();
        }

        const { matchedRegionIndex, matchedComponentIndex } = this.componentFinder(full);

        let propertyReplacementValue = this.flags.value;

        // if necessary, cast subcomponent to json
        if (this.flags.subproperty) {
            const existing = full.regions[matchedRegionIndex].components[matchedComponentIndex].componentAttributes[this.flags.property];
            if (this.flags.verbose) {
                this.ux.log(`found existing value : ${existing}`);
                this.ux.log('working on subproperty');
            }
            const jsonProperty = JSON.parse(existing);
            jsonProperty[this.flags.subproperty] = this.flags.value;
            propertyReplacementValue = JSON.stringify(jsonProperty);
        }

        full.regions[matchedRegionIndex].components[matchedComponentIndex].componentAttributes[this.flags.property] = propertyReplacementValue;

        // replace with new value
        if (this.flags.write) {
            await fs.writeJSON(this.flags.file, full, { spaces: 2 });
            this.ux.logJson(JSON.parse(full.regions[matchedRegionIndex].components[matchedComponentIndex].componentAttributes[this.flags.property]));
        } else if (!this.flags.json) {
            this.ux.logJson(full);
        }

        return full;
    }

    // queries either rest or tooling api to find the ids needed. Returns the id as a string
    private async query(): Promise<string> {
        if (this.flags.query) {
            const conn = this.org.getConnection();
            let queryResult;
            if (this.flags.tooling) {
                queryResult = await conn.tooling.query(this.flags.query);
            } else {
                queryResult = await conn.query(this.flags.query);
            }
            if (this.flags.verbose) {
                this.ux.logJson(queryResult);
            }

            if (queryResult.totalSize === 1) {
                const result = queryResult.records[0][this.flags.queryfield];
                if (this.flags.truncate) {
                    return result.substr(0, 15);
                }
                return result;
            } else if (queryResult.totalSize > 0) {
                throw new Error('multiple records found...fix your query');
            } else {
                throw new Error('no records found for your query');
            }
        }
    }

    private async getVariable(): Promise<string> {
        if (this.flags.variable === 'OrgId') {
            if (this.flags.truncate) {
                return this.org.getOrgId().substr(0, 15);
            }
            return this.org.getOrgId();
        } else if (this.flags.variable === 'Username') {
            return this.org.getUsername();
        } else if (this.flags.variable === 'InstanceUrl') {
            return this.org.getConnection().instanceUrl.replace(/\/$/, '');
        }
    }

    private componentFinder(full): IndexObject {
        const output: IndexObject = {
            matchedRegionIndex: -1
        };

        full.regions.forEach((region, regionIndex) => {
            if (output.matchedRegionIndex === -1) {
                if (this.flags.verbose) {
                    this.ux.log(`searching in ${region.regionName}, which has components ${region.components.map(component => component.id)}`);
                }
                output.matchedComponentIndex = region.components.findIndex(component => component.id === this.flags.id);
                if (output.matchedComponentIndex > -1) {
                    output.matchedRegionIndex = regionIndex;
                    return output;
                } else {
                    if (this.flags.verbose) {
                        this.ux.log('no matching component found');
                    }
                }
            }
            if (output.matchedComponentIndex === -1) {
                throw new Error('no component was found matching that id');
            }
        });
        return output;
    }
}

interface IndexObject {
    matchedRegionIndex: number;
    matchedComponentIndex?: number;
}