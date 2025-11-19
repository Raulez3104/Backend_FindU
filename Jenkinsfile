pipeline {
    agent any

    stages {
        stage('Install Dependencies') {
            steps {
                sh 'npm install'
            }
        }

        stage('Run Tests') {
            steps {
                sh 'npm test'
            }
        }
    }

    post {
        success {
            echo "Tests ejecutados correctamente."
        }
        failure {
            echo "❌ Los tests fallaron."
        }
    }
}
