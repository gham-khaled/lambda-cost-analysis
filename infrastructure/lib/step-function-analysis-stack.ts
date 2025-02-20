import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks'
import * as sfn from 'aws-cdk-lib/aws-stepfunctions'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as iam from 'aws-cdk-lib/aws-iam';

import {Aws, Duration} from "aws-cdk-lib";
import {StateMachine} from "aws-cdk-lib/aws-stepfunctions";
import {Bucket} from "aws-cdk-lib/aws-s3";

export class StepFunctionAnalysisStack extends cdk.Stack {
    public analysisStepFunction: StateMachine;
    public analysisBucket: Bucket;
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        const describeLogGroupsRole = new iam.Role(this, 'DescribeLogGroupsRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });


        // Attach the DescribeLogGroups policy to the role
        describeLogGroupsRole.addToPolicy(new iam.PolicyStatement({
            actions: ['logs:DescribeLogGroups', 'logs:StartQuery', 'logs:GetQueryResults'],
            resources: ['*'],
        }));
        describeLogGroupsRole.addToPolicy(new iam.PolicyStatement({
            actions: ['lambda:GetFunctionConfiguration'],
            resources: ['*'],
        }));

        this.analysisBucket = new s3.Bucket(this, 'AnalysisBucket');
        const pandasLayer = lambda.LayerVersion.fromLayerVersionArn(this, 'pandasLayer', `arn:aws:lambda:${Aws.REGION}:336392948345:layer:AWSSDKPandas-Python310:15`);

        const analysisAggregator = new lambda.Function(this, 'analysis_aggregator', {
            runtime: lambda.Runtime.PYTHON_3_10,
            handler: 'step_function.analysis_aggregator.lambda_handler',
            code: lambda.Code.fromAsset('../backend/'),
            timeout: Duration.seconds(900),
            layers: [pandasLayer],
            environment: {
                BUCKET_NAME: this.analysisBucket.bucketName
            }
        });
        const analysisGenerator = new lambda.Function(this, 'analysis_generator', {
            runtime: lambda.Runtime.PYTHON_3_10,
            handler: 'step_function.analysis_generator.lambda_handler',
            code: lambda.Code.fromAsset('../backend/'),
            timeout: Duration.seconds(900),
            role: describeLogGroupsRole,
            environment: {
                BUCKET_NAME: this.analysisBucket.bucketName
            }
        });
        const analysisInitializer = new lambda.Function(this, 'analysis_initializer', {
            runtime: lambda.Runtime.PYTHON_3_10,
            handler: 'step_function.analysis_initializer.lambda_handler',
            code: lambda.Code.fromAsset('../backend/'),
            timeout: Duration.seconds(900),

            environment: {
                BUCKET_NAME: this.analysisBucket.bucketName
            }
        });
        // SF Tasks
        const analysisAggregatorJob = new tasks.LambdaInvoke(this, 'analysisAggregatorJob', {
            lambdaFunction: analysisAggregator,
        });
        const analysisGeneratorJob = new tasks.LambdaInvoke(this, 'analysisGeneratorJob', {
            lambdaFunction: analysisGenerator,
        });
        const analysisInitializerJob = new tasks.LambdaInvoke(this, 'analysisInitializerJob', {
            lambdaFunction: analysisInitializer,
            outputPath: '$.Payload'

        });
        const mapLambdaBJob = new sfn.Map(this, 'analysisMap', {
            maxConcurrency: 4,
            itemsPath: sfn.JsonPath.stringAt('$.lambda_functions_name'),
            outputPath: '$[*].Payload',
            itemSelector: {
                'lambda_functions_name.$': '$$.Map.Item.Value',
                'report_id.$': '$.report_id',
                'start_date.$': '$.start_date',
                'end_date.$': '$.end_date'
            },
        }).itemProcessor(analysisGeneratorJob)

        const definition = analysisInitializerJob.next(mapLambdaBJob).next(analysisAggregatorJob)
        // TODO: Add an Error state if it fails it updates the analysis file in the S3 bucket
        this.analysisStepFunction = new sfn.StateMachine(this, 'analysisStepFunction', {
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
        });

        this.analysisBucket.grantPut(analysisInitializer)
        this.analysisBucket.grantReadWrite(analysisGenerator)
        this.analysisBucket.grantReadWrite(analysisAggregator)

    }
}
